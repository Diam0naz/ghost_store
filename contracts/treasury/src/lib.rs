//! Merchant treasury: M-of-N signer approvals over proposals.
//!
//! Design rules (these are the security story, keep them in the contract, not in the AI):
//! - A restricted `proposer` (the AI service account) may only CREATE proposals.
//! - Only `signers` may approve or reject. The proposer can never approve or execute.
//! - Yield allocations only go to whitelisted venues and never exceed the per-venue cap.
//! - Execution needs `threshold` approvals and happens at most once.

use near_sdk::json_types::U128;
use near_sdk::store::IterableMap;
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
};

const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub enum ProposalKind {
    /// Pay a vendor or contributor. `token = None` means native NEAR.
    Payout { to: AccountId, token: Option<AccountId>, amount: U128 },
    /// Move idle funds to a whitelisted yield venue (NEP-141 token only).
    Allocate { venue: AccountId, token: AccountId, amount: U128 },
}

#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub enum Status {
    Pending,
    Executed,
    Rejected,
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

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Treasury {
    signers: Vec<AccountId>,
    threshold: u32,
    proposer: AccountId,
    /// venue -> max amount per Allocate proposal
    venue_caps: IterableMap<AccountId, U128>,
    proposals: IterableMap<u64, Proposal>,
    next_id: u64,
}

#[near]
impl Treasury {
    #[init]
    pub fn new(signers: Vec<AccountId>, threshold: u32, proposer: AccountId) -> Self {
        require!(!signers.is_empty(), "need at least one signer");
        require!(
            threshold >= 1 && (threshold as usize) <= signers.len(),
            "threshold must be between 1 and the number of signers"
        );
        Self {
            signers,
            threshold,
            proposer,
            venue_caps: IterableMap::new(b"v"),
            proposals: IterableMap::new(b"p"),
            next_id: 0,
        }
    }

    // ---- views ----
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

    // ---- admin (signers act through proposals in a later iteration; for now a signer sets caps) ----
    pub fn set_venue_cap(&mut self, venue: AccountId, cap: U128) {
        self.assert_signer();
        self.venue_caps.insert(venue, cap);
    }

    // ---- proposals ----
    pub fn propose(&mut self, kind: ProposalKind, rationale: String) -> u64 {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.proposer || self.signers.contains(&caller),
            "only the proposer or a signer can propose"
        );
        require!(rationale.len() <= 500, "rationale too long");
        self.validate(&kind);

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
    pub fn approve(&mut self, id: u64) -> Option<Promise> {
        self.assert_signer();
        let caller = env::predecessor_account_id();
        let mut p = self.proposals.get(&id).cloned().expect("no such proposal");
        require!(p.status == Status::Pending, "proposal is not pending");
        require!(!p.approvals.contains(&caller), "already approved");
        p.approvals.push(caller);

        let ready = p.approvals.len() as u32 >= self.threshold;
        let promise = if ready {
            p.status = Status::Executed;
            Some(self.execute(&p.kind))
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
        p.status = Status::Rejected;
        self.proposals.insert(id, p);
    }

    // ---- internals ----
    fn assert_signer(&self) {
        require!(
            self.signers.contains(&env::predecessor_account_id()),
            "only a signer can do this"
        );
    }

    fn validate(&self, kind: &ProposalKind) {
        match kind {
            ProposalKind::Payout { amount, .. } => {
                require!(amount.0 > 0, "amount must be positive");
            }
            ProposalKind::Allocate { venue, amount, .. } => {
                require!(amount.0 > 0, "amount must be positive");
                let cap = self.venue_caps.get(venue).expect("venue is not whitelisted");
                require!(amount.0 <= cap.0, "amount exceeds the venue cap");
            }
        }
    }

    fn execute(&self, kind: &ProposalKind) -> Promise {
        match kind {
            ProposalKind::Payout { to, token: None, amount } => {
                Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount.0))
            }
            ProposalKind::Payout { to, token: Some(token), amount } => {
                Self::ft_transfer(token.clone(), to.clone(), *amount)
            }
            // TODO: replace the plain transfer with the venue's real deposit call
            // (for example ft_transfer_call with the venue's msg format). Verify in the venue docs.
            ProposalKind::Allocate { venue, token, amount } => {
                Self::ft_transfer(token.clone(), venue.clone(), *amount)
            }
        }
    }

    fn ft_transfer(token: AccountId, to: AccountId, amount: U128) -> Promise {
        Promise::new(token).function_call(
            "ft_transfer".to_string(),
            format!(r#"{{"receiver_id":"{}","amount":"{}"}}"#, to, amount.0).into_bytes(),
            ONE_YOCTO,
            FT_TRANSFER_GAS,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn ctx(who: AccountId) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(who).build());
    }

    fn setup() -> Treasury {
        // signers: alice, bob; threshold 2; proposer: charlie (the AI service)
        ctx(accounts(0));
        Treasury::new(vec![accounts(0), accounts(1)], 2, accounts(2))
    }

    #[test]
    fn proposer_proposes_signers_approve() {
        let mut t = setup();
        ctx(accounts(2));
        let id = t.propose(
            ProposalKind::Payout { to: accounts(3), token: None, amount: U128(10) },
            "pay vendor".into(),
        );
        ctx(accounts(0));
        assert!(t.approve(id).is_none());
        ctx(accounts(1));
        assert!(t.approve(id).is_some());
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Executed);
    }

    #[test]
    #[should_panic(expected = "only a signer can do this")]
    fn proposer_cannot_approve() {
        let mut t = setup();
        ctx(accounts(2));
        let id = t.propose(
            ProposalKind::Payout { to: accounts(3), token: None, amount: U128(10) },
            "x".into(),
        );
        t.approve(id);
    }

    #[test]
    #[should_panic(expected = "venue is not whitelisted")]
    fn allocation_needs_whitelisted_venue() {
        let mut t = setup();
        ctx(accounts(2));
        t.propose(
            ProposalKind::Allocate { venue: accounts(4), token: accounts(3), amount: U128(1) },
            "x".into(),
        );
    }

    #[test]
    #[should_panic(expected = "amount exceeds the venue cap")]
    fn allocation_respects_cap() {
        let mut t = setup();
        ctx(accounts(0));
        t.set_venue_cap(accounts(4), U128(100));
        ctx(accounts(2));
        t.propose(
            ProposalKind::Allocate { venue: accounts(4), token: accounts(3), amount: U128(101) },
            "x".into(),
        );
    }
}
