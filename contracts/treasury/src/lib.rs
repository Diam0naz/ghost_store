//! Merchant treasury: M-of-N signer approvals over proposals, with a policy-limited yield layer.
//!
//! Design rules (these are the security story, keep them in the contract, not in the AI):
//! - A restricted `proposer` (the AI service account) may only CREATE proposals.
//! - Only `signers` may approve or reject. The proposer can never approve or execute.
//! - Execution needs `threshold` approvals from CURRENT signers and happens at most once.
//! - Every transfer fires a callback; on failure the proposal is marked Failed, not Executed.
//! - Governance changes (signers, threshold, proposer, venue caps, policy) go through the same
//!   approval flow as payouts. No single-signer backdoor.
//! - Proposals not fully approved within PROPOSAL_TTL_MS expire.
//!
//! Yield layer (stablecoin only):
//! - `policy.stable_token` is the only token that can be allocated.
//! - Venue caps are CUMULATIVE: the principal supplied to a venue never exceeds its cap.
//! - `policy.max_total_allocated` caps principal across all venues.
//! - `policy.reserve_floor` is enforced against the live token balance at execution time
//!   (async `ft_balance_of` check), so an allocation can never drain the liquid reserve.
//! - Any single signer can `pause()` allocations (a safe-direction action). Unpausing needs a
//!   proposal. Payouts and withdrawals keep working while paused.
//! - `positions` records PRINCIPAL supplied per venue, not current value. Read the venue for value.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::IterableMap;
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

// ---- constants ---------------------------------------------------------------

/// Gas for a plain ft_transfer.
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(20);
/// Gas for ft_transfer_call. Standard FT contracts require more than ~35 Tgas to be attached.
const FT_TRANSFER_CALL_GAS: Gas = Gas::from_tgas(60);
/// Gas for ft_balance_of.
const FT_BALANCE_GAS: Gas = Gas::from_tgas(5);
/// Gas for a venue `withdraw` call.
const WITHDRAW_GAS: Gas = Gas::from_tgas(40);
/// Gas reserved for simple callbacks.
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Gas for the balance-check callback, which itself schedules ft_transfer_call + a callback.
const ALLOCATE_CHECK_CALLBACK_GAS: Gas = Gas::from_tgas(90);
/// 1 yoctoNEAR attached to NEP-141 transfers.
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// NEAR kept free on top of storage staking when paying out native NEAR (0.5 NEAR).
const STORAGE_RESERVE: NearToken = NearToken::from_millinear(500);
/// Proposals older than this are considered expired (7 days in ms).
const PROPOSAL_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1_000;

// ---- types -------------------------------------------------------------------

#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub struct Policy {
    /// The only token the yield layer may touch (the treasury's stablecoin).
    pub stable_token: AccountId,
    /// Maximum total principal allocated across all venues, in `stable_token` units.
    pub max_total_allocated: U128,
    /// Liquid `stable_token` balance that must remain after an allocation.
    pub reserve_floor: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub enum ProposalKind {
    /// Pay a vendor or contributor. `token = None` means native NEAR.
    Payout {
        to: AccountId,
        token: Option<AccountId>,
        amount: U128,
    },
    /// Supply idle stablecoin to a whitelisted yield venue via ft_transfer_call.
    Allocate {
        venue: AccountId,
        token: AccountId,
        amount: U128,
    },
    /// Pull funds back from a venue by calling its `withdraw(token_id, amount)`.
    Withdraw { venue: AccountId, amount: U128 },
    /// Governance: set the cumulative principal cap for a venue (0 removes it from the whitelist).
    SetVenueCap { venue: AccountId, cap: U128 },
    /// Governance: set the yield policy (stable token, total cap, reserve floor).
    SetPolicy {
        stable_token: AccountId,
        max_total_allocated: U128,
        reserve_floor: U128,
    },
    /// Governance: pause or unpause allocations.
    SetPaused { paused: bool },
    /// Governance: add a new signer.
    AddSigner { account_id: AccountId },
    /// Governance: remove an existing signer.
    RemoveSigner { account_id: AccountId },
    /// Governance: change the approval threshold.
    SetThreshold { threshold: u32 },
    /// Governance: rotate the AI proposer account.
    SetProposer { account_id: AccountId },
}

#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub enum Status {
    Pending,
    /// The threshold was reached and execution was started. For async kinds a later callback
    /// may flip this to Failed.
    Executed,
    /// The threshold was reached but the on-chain call failed or was refused.
    Failed,
    Rejected,
    /// The proposal was not approved within PROPOSAL_TTL_MS.
    Expired,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Proposal {
    pub id: u64,
    pub kind: ProposalKind,
    pub proposer: AccountId,
    /// Free text from the AI or a human explaining why. Keep it free of sensitive data.
    pub rationale: String,
    pub approvals: Vec<AccountId>,
    pub status: Status,
    pub created_at_ms: u64,
}

// ---- contract state ----------------------------------------------------------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Treasury {
    signers: Vec<AccountId>,
    threshold: u32,
    proposer: AccountId,
    /// venue -> max cumulative principal that may be supplied to it
    venue_caps: IterableMap<AccountId, U128>,
    proposals: IterableMap<u64, Proposal>,
    next_id: u64,
    policy: Option<Policy>,
    paused: bool,
    /// venue -> principal currently supplied (not including interest)
    positions: IterableMap<AccountId, U128>,
    total_allocated: u128,
}

// ---- implementation ----------------------------------------------------------

#[near]
impl Treasury {
    #[init]
    pub fn new(signers: Vec<AccountId>, threshold: u32, proposer: AccountId) -> Self {
        require!(!signers.is_empty(), "need at least one signer");
        require!(
            threshold >= 1 && (threshold as usize) <= signers.len(),
            "threshold must be between 1 and the number of signers"
        );
        let mut deduped: Vec<AccountId> = Vec::new();
        for s in signers {
            if !deduped.contains(&s) {
                deduped.push(s);
            }
        }
        require!(
            threshold as usize <= deduped.len(),
            "threshold exceeds unique signer count"
        );
        Self {
            signers: deduped,
            threshold,
            proposer,
            venue_caps: IterableMap::new(b"v"),
            proposals: IterableMap::new(b"p"),
            next_id: 0,
            policy: None,
            paused: false,
            positions: IterableMap::new(b"x"),
            total_allocated: 0,
        }
    }

    // ---- views ---------------------------------------------------------------

    pub fn get_config(&self) -> (Vec<AccountId>, u32, AccountId) {
        (self.signers.clone(), self.threshold, self.proposer.clone())
    }

    pub fn get_proposal(&self, id: u64) -> Option<Proposal> {
        self.proposals.get(&id).cloned()
    }

    pub fn list_proposals(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Proposal> {
        let from = from.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.next_id)
            .take(limit as usize)
            .filter_map(|i| self.proposals.get(&i).cloned())
            .collect()
    }

    pub fn get_venue_cap(&self, venue: AccountId) -> Option<U128> {
        self.venue_caps.get(&venue).copied()
    }

    pub fn get_policy(&self) -> Option<Policy> {
        self.policy.clone()
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    /// Principal supplied per venue. This is what we put in, not what it is worth now.
    pub fn get_positions(&self) -> Vec<(AccountId, U128)> {
        self.positions.iter().map(|(k, v)| (k.clone(), *v)).collect()
    }

    pub fn get_total_allocated(&self) -> U128 {
        U128(self.total_allocated)
    }

    // ---- proposals -----------------------------------------------------------

    pub fn propose(&mut self, kind: ProposalKind, rationale: String) -> u64 {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.proposer || self.signers.contains(&caller),
            "only the proposer or a signer can propose"
        );
        require!(rationale.len() <= 500, "rationale too long");
        self.validate_kind(&kind);

        let id = self.next_id;
        self.next_id += 1;
        self.proposals.insert(
            id,
            Proposal {
                id,
                kind,
                proposer: caller,
                rationale,
                approvals: vec![],
                status: Status::Pending,
                created_at_ms: env::block_timestamp_ms(),
            },
        );
        id
    }

    /// Approve a proposal. Executes automatically when the threshold is reached.
    ///
    /// Attach about 150 Tgas: allocations chain a balance check, ft_transfer_call and callbacks.
    pub fn approve(&mut self, id: u64) -> Option<Promise> {
        self.assert_signer();
        let caller = env::predecessor_account_id();
        let mut p = self.proposals.get(&id).cloned().expect("no such proposal");
        require!(p.status == Status::Pending, "proposal is not pending");
        require!(
            env::block_timestamp_ms() < p.created_at_ms + PROPOSAL_TTL_MS,
            "proposal has expired"
        );
        require!(!p.approvals.contains(&caller), "already approved");
        p.approvals.push(caller);

        // Only count approvals from accounts that are still signers.
        let valid = p.approvals.iter().filter(|a| self.signers.contains(*a)).count() as u32;

        let promise = if valid >= self.threshold {
            // State may have changed since the proposal was created: validate again.
            self.validate_kind(&p.kind);
            let promise = self.execute(&p);
            // Async kinds are optimistic; their callback flips this to Failed if needed.
            p.status = Status::Executed;
            promise
        } else {
            None
        };
        self.proposals.insert(id, p);
        promise
    }

    pub fn reject(&mut self, id: u64) {
        self.assert_signer();
        let mut p = self.proposals.get(&id).cloned().expect("no such proposal");
        require!(p.status == Status::Pending, "proposal is not pending");
        if env::block_timestamp_ms() >= p.created_at_ms + PROPOSAL_TTL_MS {
            p.status = Status::Expired;
        } else {
            p.status = Status::Rejected;
        }
        self.proposals.insert(id, p);
    }

    /// Anyone can mark a stale pending proposal as expired.
    pub fn expire(&mut self, id: u64) {
        let mut p = self.proposals.get(&id).cloned().expect("no such proposal");
        require!(p.status == Status::Pending, "proposal is not pending");
        require!(
            env::block_timestamp_ms() >= p.created_at_ms + PROPOSAL_TTL_MS,
            "proposal has not expired yet"
        );
        p.status = Status::Expired;
        self.proposals.insert(id, p);
    }

    /// Kill switch: any single signer can stop new allocations immediately.
    /// Unpausing needs a `SetPaused { paused: false }` proposal.
    pub fn pause(&mut self) {
        self.assert_signer();
        self.paused = true;
        env::log_str("allocations paused");
    }

    // ---- callbacks -----------------------------------------------------------

    /// After a payout (native or ft_transfer). Marks the proposal Failed on error.
    #[private]
    pub fn on_transfer_complete(&mut self, proposal_id: u64) {
        if env::promise_result_checked(0, 1024).is_err() {
            self.set_status(proposal_id, Status::Failed);
            env::log_str(&format!("payout for proposal #{proposal_id} failed"));
        }
    }

    /// After `ft_balance_of`: enforces the reserve floor, then sends the tokens to the venue.
    #[private]
    pub fn on_allocate_balance(
        &mut self,
        proposal_id: u64,
        venue: AccountId,
        token: AccountId,
        amount: U128,
    ) -> PromiseOrValue<()> {
        let balance = match env::promise_result_checked(0, 128) {
            Ok(bytes) => serde_json::from_slice::<U128>(&bytes).ok(),
            Err(_) => None,
        };
        let Some(balance) = balance else {
            self.rollback_allocation(proposal_id, &venue, amount.0, "could not read token balance");
            return PromiseOrValue::Value(());
        };
        let floor = self.policy().reserve_floor.0;
        if balance.0 < amount.0.saturating_add(floor) {
            self.rollback_allocation(proposal_id, &venue, amount.0, "reserve floor would be breached");
            return PromiseOrValue::Value(());
        }
        PromiseOrValue::Promise(
            Promise::new(token)
                .function_call(
                    "ft_transfer_call".to_string(),
                    json!({ "receiver_id": venue, "amount": amount, "msg": "" })
                        .to_string()
                        .into_bytes(),
                    ONE_YOCTO,
                    FT_TRANSFER_CALL_GAS,
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(CALLBACK_GAS)
                        .on_allocate_complete(proposal_id, venue, amount),
                ),
        )
    }

    /// After ft_transfer_call. The FT returns how much the venue actually kept.
    #[private]
    pub fn on_allocate_complete(&mut self, proposal_id: u64, venue: AccountId, amount: U128) {
        match env::promise_result_checked(0, 128) {
            Err(_) => self.rollback_allocation(proposal_id, &venue, amount.0, "ft_transfer_call failed"),
            Ok(bytes) => {
                if let Ok(used) = serde_json::from_slice::<U128>(&bytes) {
                    let used = used.0.min(amount.0);
                    if used < amount.0 {
                        self.sub_position(&venue, amount.0 - used);
                    }
                    if used == 0 {
                        self.set_status(proposal_id, Status::Failed);
                        env::log_str(&format!("venue refused allocation for proposal #{proposal_id}"));
                    }
                } else {
                    env::log_str("unreadable ft_transfer_call result; keeping full principal on record");
                }
            }
        }
    }

    /// After a venue `withdraw`. Venues return the amount actually paid out (U128); an empty or
    /// unreadable result is treated as "paid in full". A result of 0 means nothing was paid.
    #[private]
    pub fn on_withdraw_complete(&mut self, proposal_id: u64, venue: AccountId, amount: U128) {
        match env::promise_result_checked(0, 128) {
            Err(_) => {
                self.set_status(proposal_id, Status::Failed);
                env::log_str(&format!("withdraw for proposal #{proposal_id} failed"));
            }
            Ok(bytes) => {
                let paid = serde_json::from_slice::<U128>(&bytes)
                    .map(|v| v.0.min(amount.0))
                    .unwrap_or(amount.0);
                if paid == 0 {
                    self.set_status(proposal_id, Status::Failed);
                    env::log_str(&format!("venue paid nothing for proposal #{proposal_id}"));
                } else {
                    self.sub_position(&venue, paid);
                }
            }
        }
    }

    // ---- internals -----------------------------------------------------------

    fn assert_signer(&self) {
        require!(
            self.signers.contains(&env::predecessor_account_id()),
            "only a signer can do this"
        );
    }

    fn policy(&self) -> &Policy {
        self.policy
            .as_ref()
            .expect("policy not configured; propose SetPolicy first")
    }

    fn position(&self, venue: &AccountId) -> u128 {
        self.positions.get(venue).map(|v| v.0).unwrap_or(0)
    }

    fn add_position(&mut self, venue: &AccountId, amount: u128) {
        let new = self.position(venue).checked_add(amount).expect("position overflow");
        self.positions.insert(venue.clone(), U128(new));
        self.total_allocated = self.total_allocated.checked_add(amount).expect("total overflow");
    }

    fn sub_position(&mut self, venue: &AccountId, amount: u128) {
        let current = self.position(venue);
        let dec = amount.min(current);
        let new = current - dec;
        if new == 0 {
            self.positions.remove(venue);
        } else {
            self.positions.insert(venue.clone(), U128(new));
        }
        self.total_allocated = self.total_allocated.saturating_sub(dec);
    }

    fn set_status(&mut self, id: u64, status: Status) {
        let mut p = self.proposals.get(&id).cloned().expect("proposal missing in callback");
        p.status = status;
        self.proposals.insert(id, p);
    }

    fn rollback_allocation(&mut self, id: u64, venue: &AccountId, amount: u128, reason: &str) {
        self.sub_position(venue, amount);
        self.set_status(id, Status::Failed);
        env::log_str(&format!("allocation for proposal #{id} rolled back: {reason}"));
    }

    fn validate_kind(&self, kind: &ProposalKind) {
        match kind {
            ProposalKind::Payout { amount, .. } => {
                require!(amount.0 > 0, "amount must be positive");
            }
            ProposalKind::Allocate { venue, token, amount } => {
                require!(amount.0 > 0, "amount must be positive");
                require!(!self.paused, "allocations are paused");
                let cap = self.venue_caps.get(venue).expect("venue is not whitelisted");
                let new_principal = self.position(venue).checked_add(amount.0).expect("overflow");
                require!(new_principal <= cap.0, "amount exceeds the venue cap");
                let policy = self.policy();
                require!(
                    *token == policy.stable_token,
                    "only the policy stable token can be allocated"
                );
                let new_total = self.total_allocated.checked_add(amount.0).expect("overflow");
                require!(
                    new_total <= policy.max_total_allocated.0,
                    "amount exceeds the total allocation limit"
                );
            }
            ProposalKind::Withdraw { venue, amount } => {
                require!(amount.0 > 0, "amount must be positive");
                require!(self.positions.get(venue).is_some(), "no position at this venue");
                let _ = self.policy();
            }
            ProposalKind::SetVenueCap { .. } => {}
            ProposalKind::SetPolicy { .. } => {}
            ProposalKind::SetPaused { .. } => {}
            ProposalKind::AddSigner { account_id } => {
                require!(!self.signers.contains(account_id), "account is already a signer");
            }
            ProposalKind::RemoveSigner { account_id } => {
                require!(self.signers.contains(account_id), "account is not a signer");
                require!(self.signers.len() > 1, "cannot remove the last signer");
                require!(
                    self.threshold as usize <= self.signers.len() - 1,
                    "removal would make threshold unreachable; lower threshold first"
                );
            }
            ProposalKind::SetThreshold { threshold } => {
                require!(*threshold >= 1, "threshold must be at least 1");
                require!(
                    (*threshold as usize) <= self.signers.len(),
                    "threshold exceeds signer count"
                );
            }
            ProposalKind::SetProposer { .. } => {}
        }
    }

    /// Returns Some(Promise) for async kinds, None for synchronous governance changes.
    fn execute(&mut self, p: &Proposal) -> Option<Promise> {
        match &p.kind {
            ProposalKind::Payout { to, token: None, amount } => {
                let storage_cost =
                    env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
                let available = env::account_balance()
                    .saturating_sub(storage_cost)
                    .saturating_sub(STORAGE_RESERVE);
                require!(
                    available >= NearToken::from_yoctonear(amount.0),
                    "insufficient balance after storage reserve"
                );
                Some(
                    Promise::new(to.clone())
                        .transfer(NearToken::from_yoctonear(amount.0))
                        .then(
                            Self::ext(env::current_account_id())
                                .with_static_gas(CALLBACK_GAS)
                                .on_transfer_complete(p.id),
                        ),
                )
            }
            ProposalKind::Payout { to, token: Some(token), amount } => Some(
                Promise::new(token.clone())
                    .function_call(
                        "ft_transfer".to_string(),
                        json!({ "receiver_id": to, "amount": amount }).to_string().into_bytes(),
                        ONE_YOCTO,
                        FT_TRANSFER_GAS,
                    )
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(CALLBACK_GAS)
                            .on_transfer_complete(p.id),
                    ),
            ),
            ProposalKind::Allocate { venue, token, amount } => {
                // Reserve the principal now so two approvals in flight cannot both pass the cap.
                // Callbacks roll it back if the balance check or the transfer fails.
                self.add_position(venue, amount.0);
                Some(
                    Promise::new(token.clone())
                        .function_call(
                            "ft_balance_of".to_string(),
                            json!({ "account_id": env::current_account_id() })
                                .to_string()
                                .into_bytes(),
                            NearToken::from_yoctonear(0),
                            FT_BALANCE_GAS,
                        )
                        .then(
                            Self::ext(env::current_account_id())
                                .with_static_gas(ALLOCATE_CHECK_CALLBACK_GAS)
                                .on_allocate_balance(p.id, venue.clone(), token.clone(), *amount),
                        ),
                )
            }
            ProposalKind::Withdraw { venue, amount } => {
                let token = self.policy().stable_token.clone();
                Some(
                    Promise::new(venue.clone())
                        .function_call(
                            "withdraw".to_string(),
                            json!({ "token_id": token, "amount": amount })
                                .to_string()
                                .into_bytes(),
                            ONE_YOCTO,
                            WITHDRAW_GAS,
                        )
                        .then(
                            Self::ext(env::current_account_id())
                                .with_static_gas(CALLBACK_GAS)
                                .on_withdraw_complete(p.id, venue.clone(), *amount),
                        ),
                )
            }
            ProposalKind::SetVenueCap { venue, cap } => {
                if cap.0 == 0 {
                    self.venue_caps.remove(venue);
                } else {
                    self.venue_caps.insert(venue.clone(), *cap);
                }
                None
            }
            ProposalKind::SetPolicy { stable_token, max_total_allocated, reserve_floor } => {
                self.policy = Some(Policy {
                    stable_token: stable_token.clone(),
                    max_total_allocated: *max_total_allocated,
                    reserve_floor: *reserve_floor,
                });
                None
            }
            ProposalKind::SetPaused { paused } => {
                self.paused = *paused;
                None
            }
            ProposalKind::AddSigner { account_id } => {
                self.signers.push(account_id.clone());
                None
            }
            ProposalKind::RemoveSigner { account_id } => {
                self.signers.retain(|s| s != account_id);
                None
            }
            ProposalKind::SetThreshold { threshold } => {
                self.threshold = *threshold;
                None
            }
            ProposalKind::SetProposer { account_id } => {
                self.proposer = account_id.clone();
                None
            }
        }
    }
}

// ---- tests -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult};

    const TS_NS: u64 = 1_000_000_000_000; // 1000 s in ns

    // accounts: 0 alice (signer), 1 bob (signer), 2 charlie (AI proposer),
    // 3 danny (recipient / stable token), 4 eugene (venue), 5 fargo (other)
    fn alice() -> AccountId { accounts(0) }
    fn bob() -> AccountId { accounts(1) }
    fn ai() -> AccountId { accounts(2) }
    fn stable() -> AccountId { accounts(3) }
    fn venue() -> AccountId { accounts(4) }

    fn ctx(who: AccountId) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who)
            .block_timestamp(TS_NS)
            .build());
    }

    fn ctx_with_balance(who: AccountId, balance: NearToken) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who)
            .account_balance(balance)
            .block_timestamp(TS_NS)
            .build());
    }

    /// Callback context: predecessor is the contract itself and a promise result is available.
    fn cb_ctx(result: PromiseResult) {
        testing_env!(
            VMContextBuilder::new()
                .predecessor_account_id(env::current_account_id())
                .block_timestamp(TS_NS)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
    }

    fn ok_u128(v: u128) -> PromiseResult {
        PromiseResult::Successful(serde_json::to_vec(&U128(v)).unwrap())
    }

    fn setup() -> Treasury {
        ctx(alice());
        Treasury::new(vec![alice(), bob()], 2, ai())
    }

    /// Propose as `who`, then approve by alice and bob.
    fn pass(t: &mut Treasury, who: AccountId, kind: ProposalKind) -> u64 {
        ctx(who);
        let id = t.propose(kind, "test".into());
        ctx_with_balance(alice(), NearToken::from_near(10));
        t.approve(id);
        ctx_with_balance(bob(), NearToken::from_near(10));
        t.approve(id);
        id
    }

    /// Whitelist the venue (cap) and configure the policy.
    fn setup_yield(t: &mut Treasury, venue_cap: u128, max_total: u128, floor: u128) {
        pass(t, alice(), ProposalKind::SetVenueCap { venue: venue(), cap: U128(venue_cap) });
        pass(
            t,
            alice(),
            ProposalKind::SetPolicy {
                stable_token: stable(),
                max_total_allocated: U128(max_total),
                reserve_floor: U128(floor),
            },
        );
    }

    fn allocate(t: &mut Treasury, amount: u128) -> u64 {
        pass(
            t,
            ai(),
            ProposalKind::Allocate { venue: venue(), token: stable(), amount: U128(amount) },
        )
    }

    // ---- baseline behaviour ---------------------------------------------------

    #[test]
    fn proposer_proposes_signers_approve() {
        let mut t = setup();
        ctx(ai());
        let id = t.propose(
            ProposalKind::Payout { to: stable(), token: None, amount: U128(10) },
            "pay vendor".into(),
        );
        ctx_with_balance(alice(), NearToken::from_near(10));
        assert!(t.approve(id).is_none());
        ctx_with_balance(bob(), NearToken::from_near(10));
        assert!(t.approve(id).is_some());
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Executed);
    }

    #[test]
    #[should_panic(expected = "only a signer can do this")]
    fn proposer_cannot_approve() {
        let mut t = setup();
        ctx(ai());
        let id = t.propose(
            ProposalKind::Payout { to: stable(), token: None, amount: U128(10) },
            "x".into(),
        );
        t.approve(id);
    }

    #[test]
    #[should_panic(expected = "venue is not whitelisted")]
    fn allocation_needs_whitelisted_venue() {
        let mut t = setup();
        ctx(ai());
        t.propose(
            ProposalKind::Allocate { venue: venue(), token: stable(), amount: U128(1) },
            "x".into(),
        );
    }

    #[test]
    #[should_panic(expected = "amount exceeds the venue cap")]
    fn allocation_respects_cap() {
        let mut t = setup();
        pass(&mut t, alice(), ProposalKind::SetVenueCap { venue: venue(), cap: U128(100) });
        ctx(ai());
        t.propose(
            ProposalKind::Allocate { venue: venue(), token: stable(), amount: U128(101) },
            "x".into(),
        );
    }

    #[test]
    fn native_payout_works_with_the_demo_vault_balance() {
        // Demo vault: ~4 NEAR balance, ~170 KB of storage (about 1.7 NEAR staked).
        // A 0.5 NEAR payout must succeed with the 0.5 NEAR reserve.
        let mut t = setup();
        ctx(ai());
        let id = t.propose(
            ProposalKind::Payout {
                to: stable(),
                token: None,
                amount: U128(NearToken::from_millinear(500).as_yoctonear()),
            },
            "demo".into(),
        );
        let demo_vault = |who: AccountId| {
            testing_env!(VMContextBuilder::new()
                .predecessor_account_id(who)
                .account_balance(NearToken::from_near(4))
                .storage_usage(170_000)
                .block_timestamp(TS_NS)
                .build());
        };
        demo_vault(alice());
        t.approve(id);
        demo_vault(bob());
        assert!(t.approve(id).is_some());
    }

    #[test]
    #[should_panic(expected = "insufficient balance after storage reserve")]
    fn native_payout_rejects_when_balance_too_low() {
        let mut t = setup();
        ctx(ai());
        let id = t.propose(
            ProposalKind::Payout {
                to: stable(),
                token: None,
                amount: U128(NearToken::from_near(1000).as_yoctonear()),
            },
            "big payout".into(),
        );
        ctx_with_balance(alice(), NearToken::from_near(1));
        t.approve(id);
        ctx_with_balance(bob(), NearToken::from_near(1));
        t.approve(id);
    }

    #[test]
    fn payout_callback_sets_failed() {
        let mut t = setup();
        ctx(ai());
        let id = t.propose(
            ProposalKind::Payout { to: stable(), token: Some(accounts(5)), amount: U128(50) },
            "ft payout".into(),
        );
        t.set_status(id, Status::Executed);
        cb_ctx(PromiseResult::Failed);
        t.on_transfer_complete(id);
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Failed);
    }

    #[test]
    fn payout_callback_keeps_executed_on_success() {
        let mut t = setup();
        ctx(ai());
        let id = t.propose(
            ProposalKind::Payout { to: stable(), token: Some(accounts(5)), amount: U128(50) },
            "ft payout".into(),
        );
        t.set_status(id, Status::Executed);
        cb_ctx(PromiseResult::Successful(vec![]));
        t.on_transfer_complete(id);
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Executed);
    }

    // ---- governance -----------------------------------------------------------

    #[test]
    fn set_venue_cap_requires_threshold() {
        let mut t = setup();
        ctx(alice());
        let id = t.propose(ProposalKind::SetVenueCap { venue: venue(), cap: U128(500) }, "x".into());
        ctx(alice());
        t.approve(id);
        assert!(t.get_venue_cap(venue()).is_none());
        ctx(bob());
        t.approve(id);
        assert_eq!(t.get_venue_cap(venue()), Some(U128(500)));
    }

    #[test]
    fn add_signer_through_proposal() {
        let mut t = setup();
        pass(&mut t, alice(), ProposalKind::AddSigner { account_id: stable() });
        let (signers, _, _) = t.get_config();
        assert!(signers.contains(&stable()));
    }

    #[test]
    fn remove_signer_through_proposal() {
        let mut t = setup();
        pass(&mut t, alice(), ProposalKind::SetThreshold { threshold: 1 });
        ctx(alice());
        let id = t.propose(ProposalKind::RemoveSigner { account_id: bob() }, "remove bob".into());
        ctx(alice());
        t.approve(id); // threshold is 1 now
        let (signers, _, _) = t.get_config();
        assert!(!signers.contains(&bob()));
    }

    #[test]
    fn set_proposer_through_proposal() {
        let mut t = setup();
        pass(&mut t, alice(), ProposalKind::SetProposer { account_id: accounts(5) });
        let (_, _, proposer) = t.get_config();
        assert_eq!(proposer, accounts(5));
    }

    #[test]
    fn new_deduplicates_signers() {
        ctx(alice());
        let t = Treasury::new(vec![alice(), alice(), bob()], 2, ai());
        assert_eq!(t.get_config().0.len(), 2);
    }

    #[test]
    #[should_panic(expected = "proposal has expired")]
    fn expired_proposal_cannot_be_approved() {
        let mut t = setup();
        testing_env!(VMContextBuilder::new().predecessor_account_id(ai()).block_timestamp(0).build());
        let id = t.propose(
            ProposalKind::Payout { to: stable(), token: None, amount: U128(1) },
            "will expire".into(),
        );
        let expired_ns = (PROPOSAL_TTL_MS + 1) * 1_000_000;
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(alice())
            .block_timestamp(expired_ns)
            .build());
        t.approve(id);
    }

    #[test]
    fn anyone_can_expire_a_stale_proposal() {
        let mut t = setup();
        testing_env!(VMContextBuilder::new().predecessor_account_id(ai()).block_timestamp(0).build());
        let id = t.propose(
            ProposalKind::Payout { to: stable(), token: None, amount: U128(1) },
            "stale".into(),
        );
        let later = (PROPOSAL_TTL_MS + 1) * 1_000_000;
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(5))
            .block_timestamp(later)
            .build());
        t.expire(id);
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Expired);
    }

    #[test]
    #[should_panic(expected = "proposal has not expired yet")]
    fn fresh_proposal_cannot_be_expired() {
        let mut t = setup();
        ctx(ai());
        let id = t.propose(
            ProposalKind::Payout { to: stable(), token: None, amount: U128(1) },
            "fresh".into(),
        );
        t.expire(id);
    }

    #[test]
    fn approvals_from_removed_signers_do_not_count() {
        // signers a, b, c; threshold 2
        ctx(alice());
        let mut t = Treasury::new(vec![alice(), bob(), stable()], 2, ai());
        ctx(ai());
        let pay = t.propose(
            ProposalKind::Payout { to: accounts(5), token: None, amount: U128(10) },
            "pay".into(),
        );
        // bob approves the payout, then bob is voted out
        ctx_with_balance(bob(), NearToken::from_near(10));
        t.approve(pay);
        ctx(alice());
        let rm = t.propose(ProposalKind::RemoveSigner { account_id: bob() }, "rm".into());
        ctx(alice());
        t.approve(rm);
        ctx(stable());
        t.approve(rm);
        assert!(!t.get_config().0.contains(&bob()));
        // alice approves: approvals are [bob, alice] but bob no longer counts
        ctx_with_balance(alice(), NearToken::from_near(10));
        assert!(t.approve(pay).is_none());
        assert_eq!(t.get_proposal(pay).unwrap().status, Status::Pending);
        // stable (danny) is a signer and approves: now 2 valid approvals
        ctx_with_balance(stable(), NearToken::from_near(10));
        assert!(t.approve(pay).is_some());
    }

    // ---- yield layer: validation ---------------------------------------------

    #[test]
    #[should_panic(expected = "policy not configured")]
    fn allocation_needs_policy() {
        let mut t = setup();
        pass(&mut t, alice(), ProposalKind::SetVenueCap { venue: venue(), cap: U128(100) });
        ctx(ai());
        t.propose(
            ProposalKind::Allocate { venue: venue(), token: stable(), amount: U128(10) },
            "x".into(),
        );
    }

    #[test]
    #[should_panic(expected = "only the policy stable token can be allocated")]
    fn allocation_must_use_the_stable_token() {
        let mut t = setup();
        setup_yield(&mut t, 100, 1_000, 0);
        ctx(ai());
        t.propose(
            ProposalKind::Allocate { venue: venue(), token: accounts(5), amount: U128(10) },
            "x".into(),
        );
    }

    #[test]
    #[should_panic(expected = "amount exceeds the total allocation limit")]
    fn allocation_respects_total_limit() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 50, 0);
        ctx(ai());
        t.propose(
            ProposalKind::Allocate { venue: venue(), token: stable(), amount: U128(51) },
            "x".into(),
        );
    }

    #[test]
    fn allocation_books_principal_on_approval() {
        let mut t = setup();
        setup_yield(&mut t, 100, 1_000, 0);
        allocate(&mut t, 60);
        assert_eq!(t.get_total_allocated(), U128(60));
        assert_eq!(t.get_positions(), vec![(venue(), U128(60))]);
    }

    #[test]
    #[should_panic(expected = "amount exceeds the venue cap")]
    fn venue_cap_is_cumulative() {
        let mut t = setup();
        setup_yield(&mut t, 100, 1_000, 0);
        allocate(&mut t, 60);
        ctx(ai());
        t.propose(
            ProposalKind::Allocate { venue: venue(), token: stable(), amount: U128(60) },
            "second".into(),
        );
    }

    // ---- yield layer: pause ---------------------------------------------------

    #[test]
    fn single_signer_can_pause() {
        let mut t = setup();
        ctx(alice());
        t.pause();
        assert!(t.is_paused());
    }

    #[test]
    #[should_panic(expected = "allocations are paused")]
    fn pause_blocks_new_allocations() {
        let mut t = setup();
        setup_yield(&mut t, 100, 1_000, 0);
        ctx(alice());
        t.pause();
        ctx(ai());
        t.propose(
            ProposalKind::Allocate { venue: venue(), token: stable(), amount: U128(1) },
            "x".into(),
        );
    }

    #[test]
    #[should_panic(expected = "allocations are paused")]
    fn pause_blocks_execution_of_already_proposed_allocations() {
        let mut t = setup();
        setup_yield(&mut t, 100, 1_000, 0);
        ctx(ai());
        let id = t.propose(
            ProposalKind::Allocate { venue: venue(), token: stable(), amount: U128(10) },
            "x".into(),
        );
        ctx(alice());
        t.pause();
        ctx(alice());
        t.approve(id);
        ctx(bob());
        t.approve(id); // threshold reached: re-validation sees the pause
    }

    #[test]
    #[should_panic(expected = "only a signer can do this")]
    fn proposer_cannot_pause() {
        let mut t = setup();
        ctx(ai());
        t.pause();
    }

    #[test]
    fn unpause_needs_a_proposal() {
        let mut t = setup();
        ctx(alice());
        t.pause();
        pass(&mut t, alice(), ProposalKind::SetPaused { paused: false });
        assert!(!t.is_paused());
    }

    // ---- yield layer: async callbacks ----------------------------------------

    #[test]
    fn reserve_floor_breach_rolls_back() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 100);
        let id = allocate(&mut t, 60);
        // balance 150 < amount 60 + floor 100
        cb_ctx(ok_u128(150));
        let out = t.on_allocate_balance(id, venue(), stable(), U128(60));
        assert!(matches!(out, PromiseOrValue::Value(())));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Failed);
        assert_eq!(t.get_total_allocated(), U128(0));
        assert!(t.get_positions().is_empty());
        assert!(get_logs().iter().any(|l| l.contains("reserve floor would be breached")));
    }

    #[test]
    fn enough_balance_sends_tokens_to_the_venue() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 100);
        let id = allocate(&mut t, 60);
        cb_ctx(ok_u128(160)); // exactly amount + floor
        let out = t.on_allocate_balance(id, venue(), stable(), U128(60));
        assert!(matches!(out, PromiseOrValue::Promise(_)));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Executed);
        assert_eq!(t.get_total_allocated(), U128(60));
    }

    #[test]
    fn unreadable_balance_rolls_back() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        let id = allocate(&mut t, 60);
        cb_ctx(PromiseResult::Failed);
        let out = t.on_allocate_balance(id, venue(), stable(), U128(60));
        assert!(matches!(out, PromiseOrValue::Value(())));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Failed);
        assert_eq!(t.get_total_allocated(), U128(0));
    }

    #[test]
    fn failed_ft_transfer_call_rolls_back() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        let id = allocate(&mut t, 60);
        cb_ctx(PromiseResult::Failed);
        t.on_allocate_complete(id, venue(), U128(60));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Failed);
        assert_eq!(t.get_total_allocated(), U128(0));
    }

    #[test]
    fn partial_use_adjusts_principal() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        let id = allocate(&mut t, 60);
        cb_ctx(ok_u128(40)); // venue kept only 40
        t.on_allocate_complete(id, venue(), U128(60));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Executed);
        assert_eq!(t.get_total_allocated(), U128(40));
        assert_eq!(t.get_positions(), vec![(venue(), U128(40))]);
    }

    #[test]
    fn venue_refusing_everything_marks_failed() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        let id = allocate(&mut t, 60);
        cb_ctx(ok_u128(0));
        t.on_allocate_complete(id, venue(), U128(60));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Failed);
        assert_eq!(t.get_total_allocated(), U128(0));
    }

    #[test]
    fn full_use_keeps_principal() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        let id = allocate(&mut t, 60);
        cb_ctx(ok_u128(60));
        t.on_allocate_complete(id, venue(), U128(60));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Executed);
        assert_eq!(t.get_total_allocated(), U128(60));
    }

    // ---- yield layer: withdraw ------------------------------------------------

    #[test]
    #[should_panic(expected = "no position at this venue")]
    fn withdraw_needs_a_position() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        ctx(ai());
        t.propose(ProposalKind::Withdraw { venue: venue(), amount: U128(10) }, "x".into());
    }

    #[test]
    fn withdraw_reduces_principal_on_success() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        allocate(&mut t, 60);
        let id = pass(&mut t, ai(), ProposalKind::Withdraw { venue: venue(), amount: U128(25) });
        cb_ctx(PromiseResult::Successful(vec![]));
        t.on_withdraw_complete(id, venue(), U128(25));
        assert_eq!(t.get_total_allocated(), U128(35));
        assert_eq!(t.get_positions(), vec![(venue(), U128(35))]);
    }

    #[test]
    fn venue_paying_less_reduces_principal_by_what_was_paid() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        allocate(&mut t, 60);
        let id = pass(&mut t, ai(), ProposalKind::Withdraw { venue: venue(), amount: U128(25) });
        cb_ctx(ok_u128(10));
        t.on_withdraw_complete(id, venue(), U128(25));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Executed);
        assert_eq!(t.get_total_allocated(), U128(50));
    }

    #[test]
    fn venue_paying_zero_marks_failed() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        allocate(&mut t, 60);
        let id = pass(&mut t, ai(), ProposalKind::Withdraw { venue: venue(), amount: U128(25) });
        cb_ctx(ok_u128(0));
        t.on_withdraw_complete(id, venue(), U128(25));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Failed);
        assert_eq!(t.get_total_allocated(), U128(60));
    }

    #[test]
    fn withdrawing_more_than_principal_clears_the_position() {
        // amount can include interest; principal bottoms out at zero
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        allocate(&mut t, 60);
        let id = pass(&mut t, ai(), ProposalKind::Withdraw { venue: venue(), amount: U128(75) });
        cb_ctx(PromiseResult::Successful(vec![]));
        t.on_withdraw_complete(id, venue(), U128(75));
        assert_eq!(t.get_total_allocated(), U128(0));
        assert!(t.get_positions().is_empty());
    }

    #[test]
    fn failed_withdraw_leaves_principal_and_marks_failed() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        allocate(&mut t, 60);
        let id = pass(&mut t, ai(), ProposalKind::Withdraw { venue: venue(), amount: U128(25) });
        cb_ctx(PromiseResult::Failed);
        t.on_withdraw_complete(id, venue(), U128(25));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Failed);
        assert_eq!(t.get_total_allocated(), U128(60));
    }

    #[test]
    fn withdraw_is_allowed_while_paused() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        allocate(&mut t, 60);
        ctx(alice());
        t.pause();
        ctx(ai());
        t.propose(ProposalKind::Withdraw { venue: venue(), amount: U128(10) }, "exit".into());
    }
}
