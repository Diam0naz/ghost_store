//! Ghost Store cold vault: savings that only one device can ask for, slowly, into one place.
//!
//! - Funds arrive as plain NEP-141 transfers of one token (`ft_transfer_call` with any msg).
//! - Only the registered device key can request a release (`env::signer_account_pk`), and only
//!   by calling directly, not through another contract.
//! - A request waits `release_delay_ms`, then pays out in `installments`, one per
//!   `installment_interval_ms`, never more than `weekly_cap` per UTC week across requests.
//! - Releases can only go to `destination` (the shop's operating treasury).
//! - Any one guardian can cancel a request or freeze the vault. Unfreezing, and every rule change
//!   (device key, destination, limits, guardians), needs the guardian threshold and then waits
//!   `change_delay_ms`, during which any one guardian can cancel it.
//!
//! Design and threat model: docs/COLD-VAULT.md.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::IterableMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue, PublicKey,
};

const HOUR_MS: u64 = 3_600_000;
const DAY_MS: u64 = 24 * HOUR_MS;
const WEEK_MS: u64 = 7 * DAY_MS;
const GAS_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
pub const MAX_GUARDIANS: usize = 10;

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Requests,
    Changes,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Limits {
    /// Wait between a request and its first installment.
    pub release_delay_ms: u64,
    /// Number of equal slices a request pays out in (the last one takes the remainder).
    pub installments: u32,
    /// Wait between installments.
    pub installment_interval_ms: u64,
    /// Most released per UTC week across all requests, in token base units. 0 = no weekly cap.
    pub weekly_cap: U128,
    /// Wait between a rule change reaching the guardian threshold and taking effect.
    pub change_delay_ms: u64,
}

impl Limits {
    fn validate(&self) {
        require!(
            (HOUR_MS..=14 * DAY_MS).contains(&self.release_delay_ms),
            "release delay must be 1 hour to 14 days"
        );
        require!((1..=30).contains(&self.installments), "installments must be 1 to 30");
        require!(
            (HOUR_MS..=WEEK_MS).contains(&self.installment_interval_ms),
            "installment interval must be 1 hour to 7 days"
        );
        require!(
            (DAY_MS..=30 * DAY_MS).contains(&self.change_delay_ms),
            "change delay must be 1 to 30 days"
        );
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum RequestStatus {
    Pending,
    Completed,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub id: u64,
    pub amount: U128,
    pub paid: U128,
    pub installments_paid: u32,
    /// Installment count and spacing are fixed when the request is made.
    pub installments: u32,
    pub installment_interval_ms: u64,
    pub note: String,
    pub created_at_ms: u64,
    pub first_release_at_ms: u64,
    pub status: RequestStatus,
    pub cancelled_by: Option<AccountId>,
}

impl Request {
    fn slice(&self, index: u32) -> u128 {
        let base = self.amount.0 / self.installments as u128;
        if index + 1 == self.installments {
            self.amount.0 - base * (self.installments as u128 - 1)
        } else {
            base
        }
    }

    /// Installments whose time has come (paid or not).
    fn due(&self, now: u64) -> u32 {
        if now < self.first_release_at_ms {
            return 0;
        }
        let n = 1 + (now - self.first_release_at_ms) / self.installment_interval_ms;
        n.min(self.installments as u64) as u32
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum ChangeKind {
    SetDevice { key: PublicKey },
    SetDestination { account_id: AccountId },
    SetLimits { limits: Limits },
    SetGuardians { guardians: Vec<AccountId>, threshold: u32 },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum ChangeStatus {
    Pending,
    Applied,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Change {
    pub id: u64,
    pub kind: ChangeKind,
    pub approvals: Vec<AccountId>,
    pub proposed_at_ms: u64,
    /// Set when approvals reach the threshold.
    pub executable_after_ms: Option<u64>,
    pub status: ChangeStatus,
}

#[near(serializers = [json])]
pub struct VaultStatus {
    pub token: AccountId,
    pub destination: AccountId,
    pub guardians: Vec<AccountId>,
    pub threshold: u32,
    pub device_key: PublicKey,
    pub limits: Limits,
    pub frozen: bool,
    pub unfreeze_approvals: Vec<AccountId>,
    /// Tokens on the vault's books.
    pub held: U128,
    /// Still owed to pending requests.
    pub committed: U128,
    /// What a new request may ask for.
    pub available: U128,
    pub released_this_week: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct ColdVault {
    token: AccountId,
    destination: AccountId,
    guardians: Vec<AccountId>,
    threshold: u32,
    device_key: PublicKey,
    limits: Limits,
    frozen: bool,
    unfreeze_approvals: Vec<AccountId>,
    held: u128,
    committed: u128,
    week: u64,
    released_this_week: u128,
    next_request: u64,
    requests: IterableMap<u64, Request>,
    next_change: u64,
    changes: IterableMap<u64, Change>,
}

fn dedupe(v: Vec<AccountId>) -> Vec<AccountId> {
    let mut out: Vec<AccountId> = Vec::new();
    for a in v {
        if !out.contains(&a) {
            out.push(a);
        }
    }
    out
}

fn check_guardians(guardians: &[AccountId], threshold: u32) {
    require!(!guardians.is_empty() && guardians.len() <= MAX_GUARDIANS, "1-10 guardians");
    require!(threshold >= 1 && threshold as usize <= guardians.len(), "threshold must be 1..=guardians");
}

#[near]
impl ColdVault {
    #[init]
    pub fn new(
        token: AccountId,
        destination: AccountId,
        guardians: Vec<AccountId>,
        threshold: u32,
        device_key: PublicKey,
        limits: Limits,
    ) -> Self {
        let guardians = dedupe(guardians);
        check_guardians(&guardians, threshold);
        limits.validate();
        require!(destination != env::current_account_id(), "destination cannot be the vault");
        Self {
            token,
            destination,
            guardians,
            threshold,
            device_key,
            limits,
            frozen: false,
            unfreeze_approvals: Vec::new(),
            held: 0,
            committed: 0,
            week: 0,
            released_this_week: 0,
            next_request: 0,
            requests: IterableMap::new(Key::Requests),
            next_change: 0,
            changes: IterableMap::new(Key::Changes),
        }
    }

    // ---- deposits ----------------------------------------------------------------

    /// NEP-141 receiver: any transfer of the vault's token is a deposit.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let _ = msg;
        require!(env::predecessor_account_id() == self.token, "only the vault's token");
        self.held += amount.0;
        env::log_str(&format!("deposit: {} from {sender_id}", amount.0));
        PromiseOrValue::Value(U128(0))
    }

    // ---- the device ----------------------------------------------------------------

    /// Ask for funds. Must be signed with the registered device key and sent directly.
    pub fn request_release(&mut self, amount: U128, note: String) -> u64 {
        require!(!self.frozen, "vault is frozen");
        require!(
            env::predecessor_account_id() == env::signer_account_id(),
            "call directly, not through another contract"
        );
        require!(env::signer_account_pk() == self.device_key, "not signed by the registered device");
        require!(amount.0 > 0, "amount must be positive");
        require!(note.len() <= 200, "note too long");
        require!(amount.0 <= self.held.saturating_sub(self.committed), "more than the vault can commit");

        let now = env::block_timestamp_ms();
        let id = self.next_request;
        self.next_request += 1;
        self.committed += amount.0;
        let req = Request {
            id,
            amount,
            paid: U128(0),
            installments_paid: 0,
            installments: self.limits.installments,
            installment_interval_ms: self.limits.installment_interval_ms,
            note,
            created_at_ms: now,
            first_release_at_ms: now + self.limits.release_delay_ms,
            status: RequestStatus::Pending,
            cancelled_by: None,
        };
        env::log_str(&format!(
            "release request #{id}: {} in {} installments, first at {} ms",
            amount.0, req.installments, req.first_release_at_ms
        ));
        self.requests.insert(id, req);
        id
    }

    // ---- releases (anyone) ---------------------------------------------------------

    /// Pay the next installment of a request once it is due. Anyone may call it (a keeper).
    pub fn release(&mut self, id: u64) -> Promise {
        require!(!self.frozen, "vault is frozen");
        let now = env::block_timestamp_ms();
        let mut req = self.requests.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such request"));
        require!(req.status == RequestStatus::Pending, "request is not pending");
        require!(req.due(now) > req.installments_paid, "no installment is due yet");

        let slice = req.slice(req.installments_paid);
        let week = now / WEEK_MS;
        if week != self.week {
            self.week = week;
            self.released_this_week = 0;
        }
        let cap = self.limits.weekly_cap.0;
        require!(cap == 0 || self.released_this_week + slice <= cap, "weekly release cap reached");

        req.installments_paid += 1;
        req.paid = U128(req.paid.0 + slice);
        if req.installments_paid == req.installments {
            req.status = RequestStatus::Completed;
        }
        self.requests.insert(id, req);
        self.released_this_week += slice;
        self.committed -= slice;
        self.held -= slice;

        Promise::new(self.token.clone())
            .function_call(
                "ft_transfer".to_string(),
                json!({ "receiver_id": self.destination, "amount": U128(slice), "memo": format!("cold vault release #{id}") })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_TRANSFER,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_released(id, U128(slice), week))
    }

    /// Undo the books if the transfer failed, so the installment can be retried.
    #[private]
    pub fn on_released(&mut self, id: u64, slice: U128, week: u64) -> bool {
        if env::promise_result_checked(0, 64).is_ok() {
            env::log_str(&format!("released {} for request #{id}", slice.0));
            return true;
        }
        self.held += slice.0;
        if let Some(req) = self.requests.get_mut(&id) {
            req.installments_paid -= 1;
            req.paid = U128(req.paid.0 - slice.0);
            if req.status == RequestStatus::Completed {
                req.status = RequestStatus::Pending;
            }
            if req.status == RequestStatus::Pending {
                self.committed += slice.0;
            }
        }
        if self.week == week {
            self.released_this_week = self.released_this_week.saturating_sub(slice.0);
        }
        env::log_str(&format!("release of {} for request #{id} failed; rolled back", slice.0));
        false
    }

    // ---- guardians: one is enough to stop ------------------------------------------

    pub fn cancel_request(&mut self, id: u64) {
        let caller = self.assert_guardian();
        let req = self.requests.get_mut(&id).unwrap_or_else(|| env::panic_str("no such request"));
        require!(req.status == RequestStatus::Pending, "request is not pending");
        req.status = RequestStatus::Cancelled;
        req.cancelled_by = Some(caller.clone());
        self.committed -= req.amount.0 - req.paid.0;
        env::log_str(&format!("request #{id} cancelled by {caller}"));
    }

    pub fn freeze(&mut self) {
        let caller = self.assert_guardian();
        self.frozen = true;
        self.unfreeze_approvals.clear();
        env::log_str(&format!("vault frozen by {caller}"));
    }

    /// Unfreezing needs the guardian threshold.
    pub fn approve_unfreeze(&mut self) -> bool {
        let caller = self.assert_guardian();
        require!(self.frozen, "vault is not frozen");
        if !self.unfreeze_approvals.contains(&caller) {
            self.unfreeze_approvals.push(caller);
        }
        if self.unfreeze_approvals.len() as u32 >= self.threshold {
            self.frozen = false;
            self.unfreeze_approvals.clear();
            env::log_str("vault unfrozen");
            return true;
        }
        false
    }

    // ---- guardians: rule changes (threshold + delay) -------------------------------

    pub fn propose_change(&mut self, kind: ChangeKind) -> u64 {
        let caller = self.assert_guardian();
        match &kind {
            ChangeKind::SetLimits { limits } => limits.validate(),
            ChangeKind::SetGuardians { guardians, threshold } => check_guardians(&dedupe(guardians.clone()), *threshold),
            ChangeKind::SetDestination { account_id } => {
                require!(*account_id != env::current_account_id(), "destination cannot be the vault")
            }
            ChangeKind::SetDevice { .. } => {}
        }
        let id = self.next_change;
        self.next_change += 1;
        let mut change = Change {
            id,
            kind,
            approvals: vec![caller],
            proposed_at_ms: env::block_timestamp_ms(),
            executable_after_ms: None,
            status: ChangeStatus::Pending,
        };
        self.arm(&mut change);
        self.changes.insert(id, change);
        id
    }

    pub fn approve_change(&mut self, id: u64) {
        let caller = self.assert_guardian();
        let mut change = self.changes.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such change"));
        require!(change.status == ChangeStatus::Pending, "change is not pending");
        require!(!change.approvals.contains(&caller), "already approved");
        change.approvals.push(caller);
        self.arm(&mut change);
        self.changes.insert(id, change);
    }

    /// Any one guardian can stop a rule change before it takes effect.
    pub fn cancel_change(&mut self, id: u64) {
        let caller = self.assert_guardian();
        let change = self.changes.get_mut(&id).unwrap_or_else(|| env::panic_str("no such change"));
        require!(change.status == ChangeStatus::Pending, "change is not pending");
        change.status = ChangeStatus::Cancelled;
        env::log_str(&format!("change #{id} cancelled by {caller}"));
    }

    /// Anyone may apply a change once its delay has passed.
    pub fn apply_change(&mut self, id: u64) {
        let mut change = self.changes.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such change"));
        require!(change.status == ChangeStatus::Pending, "change is not pending");
        let after = change.executable_after_ms.unwrap_or_else(|| env::panic_str("change lacks approvals"));
        require!(env::block_timestamp_ms() >= after, "change delay has not passed");
        // Approvals from accounts that are no longer guardians do not count.
        let still = change.approvals.iter().filter(|a| self.guardians.contains(a)).count() as u32;
        require!(still >= self.threshold, "change lacks approvals");

        match change.kind.clone() {
            ChangeKind::SetDevice { key } => self.device_key = key,
            ChangeKind::SetDestination { account_id } => self.destination = account_id,
            ChangeKind::SetLimits { limits } => self.limits = limits,
            ChangeKind::SetGuardians { guardians, threshold } => {
                self.guardians = dedupe(guardians);
                self.threshold = threshold;
                self.unfreeze_approvals.clear();
            }
        }
        change.status = ChangeStatus::Applied;
        self.changes.insert(id, change);
        env::log_str(&format!("change #{id} applied"));
    }

    // ---- views ---------------------------------------------------------------------

    pub fn get_status(&self) -> VaultStatus {
        let week_now = env::block_timestamp_ms() / WEEK_MS;
        VaultStatus {
            token: self.token.clone(),
            destination: self.destination.clone(),
            guardians: self.guardians.clone(),
            threshold: self.threshold,
            device_key: self.device_key.clone(),
            limits: self.limits.clone(),
            frozen: self.frozen,
            unfreeze_approvals: self.unfreeze_approvals.clone(),
            held: U128(self.held),
            committed: U128(self.committed),
            available: U128(self.held.saturating_sub(self.committed)),
            released_this_week: U128(if week_now == self.week { self.released_this_week } else { 0 }),
        }
    }

    pub fn get_request(&self, id: u64) -> Option<Request> {
        self.requests.get(&id).cloned()
    }

    pub fn list_requests(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Request> {
        let from = from.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.next_request).take(limit as usize).filter_map(|i| self.requests.get(&i).cloned()).collect()
    }

    pub fn list_changes(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Change> {
        let from = from.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.next_change).take(limit as usize).filter_map(|i| self.changes.get(&i).cloned()).collect()
    }

    // ---- internal ------------------------------------------------------------------

    fn assert_guardian(&self) -> AccountId {
        let caller = env::predecessor_account_id();
        require!(self.guardians.contains(&caller), "only a guardian");
        caller
    }

    /// Start the change delay once approvals reach the threshold.
    fn arm(&self, change: &mut Change) {
        if change.executable_after_ms.is_none() && change.approvals.len() as u32 >= self.threshold {
            change.executable_after_ms = Some(env::block_timestamp_ms() + self.limits.change_delay_ms);
        }
    }
}

#[cfg(test)]
mod tests;
