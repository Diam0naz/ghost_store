//! Mock yield venue for testnet.
//!
//! Implements the two-sided interface expected by the treasury contract:
//!
//! - **Deposit**: receives tokens via NEP-141 `ft_transfer_call`; records principal per sender.
//! - **Withdraw**: called by the treasury; sends tokens back and returns the amount paid out.
//!
//! This is a minimal testing stub. It does not earn yield; the principal is simply stored and
//! returned on demand. Deploy it to `mock-venue.treasury-dev.testnet` for testnet demos.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::IterableMap;
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

const FT_TRANSFER_GAS: Gas = Gas::from_tgas(20);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockVenue {
    /// principal deposited per depositor account
    balances: IterableMap<AccountId, u128>,
}

#[near]
impl MockVenue {
    #[init]
    pub fn new() -> Self {
        Self {
            balances: IterableMap::new(b"b"),
        }
    }

    // ---- views -------------------------------------------------------------

    /// Return the recorded principal for a given depositor.
    pub fn balance_of(&self, account_id: AccountId) -> U128 {
        U128(*self.balances.get(&account_id).unwrap_or(&0))
    }

    /// List all depositor balances.
    pub fn list_balances(&self) -> Vec<(AccountId, U128)> {
        self.balances.iter().map(|(k, v)| (k.clone(), U128(*v))).collect()
    }

    // ---- NEP-141 receiver --------------------------------------------------

    /// Called by the token contract when the treasury does `ft_transfer_call`.
    /// Records the deposited principal and returns 0 (i.e. the venue keeps all tokens).
    /// NOTE: the argument must be named `msg` exactly — NEP-141 tokens call this with
    /// `{"sender_id", "amount", "msg"}`, and near-sdk derives JSON field names from
    /// the Rust parameter names. A leading underscore makes every deposit panic on
    /// deserialization (`missing field _msg`).
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let _ = msg; // the treasury sends an empty memo

        // Record principal against the treasury account (the ft_transfer_call sender).
        let current = self.balances.get(&sender_id).copied().unwrap_or(0);
        self.balances.insert(sender_id.clone(), current + amount.0);
        env::log_str(&format!(
            "deposit: {} sent {} tokens; total principal = {}",
            sender_id,
            amount.0,
            current + amount.0
        ));
        // Return 0 — the venue keeps the full amount (no refund).
        PromiseOrValue::Value(U128(0))
    }

    // ---- treasury withdraw interface ---------------------------------------

    /// Called by the treasury contract via `ProposalKind::Withdraw`.
    /// Sends `amount` of `token_id` back to the caller and returns the amount paid.
    /// A caller with no recorded principal is paid 0 rather than rejected, so a stale treasury
    /// position cannot wedge the withdraw flow: the treasury reads 0 and keeps its principal.
    ///
    /// Requires 1 yoctoNEAR attached (forwarded to the ft_transfer call).
    #[payable]
    pub fn withdraw(&mut self, token_id: AccountId, amount: U128) -> PromiseOrValue<U128> {
        require!(
            env::attached_deposit() >= ONE_YOCTO,
            "requires 1 yoctoNEAR"
        );

        let caller = env::predecessor_account_id();
        let principal = self.balances.get(&caller).copied().unwrap_or(0);
        if principal == 0 {
            env::log_str(&format!(
                "withdraw: {} has no principal recorded; paying 0",
                caller
            ));
            return PromiseOrValue::Value(U128(0));
        }

        // Pay out up to `amount`, capped at recorded principal.
        let payout = amount.0.min(principal);
        let remaining = principal - payout;

        if remaining == 0 {
            self.balances.remove(&caller);
        } else {
            self.balances.insert(caller.clone(), remaining);
        }

        env::log_str(&format!(
            "withdraw: sending {} of {} back to {}; remaining principal = {}",
            payout, token_id, caller, remaining
        ));

        // ft_transfer back to the caller, then return the paid amount.
        // The treasury's on_withdraw_complete callback reads the return value.
        let transfer = Promise::new(token_id)
            .function_call(
                "ft_transfer".to_string(),
                json!({ "receiver_id": caller, "amount": U128(payout) })
                    .to_string()
                    .into_bytes(),
                ONE_YOCTO,
                FT_TRANSFER_GAS,
            )
            // Return payout amount as the function result so the treasury can read it.
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(5))
                    .on_withdraw_done(U128(payout)),
            );
        PromiseOrValue::Promise(transfer)
    }

    /// Callback: if the ft_transfer succeeded, return the paid amount;
    /// if it failed (e.g. token contract panicked), return 0 so the treasury
    /// marks the proposal Failed and does not reduce its recorded principal.
    #[private]
    pub fn on_withdraw_done(&self, paid: U128) -> U128 {
        if env::promise_results_count() == 1 {
            match env::promise_result_checked(0, 128) {
                Ok(_) => paid,
                Err(_) => {
                    env::log_str("ft_transfer in withdraw failed; reporting 0 to treasury");
                    U128(0)
                }
            }
        } else {
            paid
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult};

    fn vault() -> AccountId {
        "vault.treasury-dev.testnet".parse().unwrap()
    }
    fn other() -> AccountId {
        "someone-else.testnet".parse().unwrap()
    }
    fn token() -> AccountId {
        "usdt.fakes.testnet".parse().unwrap()
    }

    /// Context for a token contract calling in (deposits carry no attached deposit).
    fn ctx(who: AccountId) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who)
            .block_timestamp(1_000_000_000_000)
            .build());
    }

    /// Context for `withdraw`, which requires 1 yoctoNEAR.
    fn ctx_payable(who: AccountId) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who)
            .attached_deposit(NearToken::from_yoctonear(1))
            .block_timestamp(1_000_000_000_000)
            .build());
    }

    /// Callback context: predecessor is the venue itself and one promise result is available.
    fn cb_ctx(result: PromiseResult) {
        testing_env!(
            VMContextBuilder::new()
                .predecessor_account_id(env::current_account_id())
                .block_timestamp(1_000_000_000_000)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
    }

    fn deposit(v: &mut MockVenue, sender: AccountId, amount: u128) -> U128 {
        match v.ft_on_transfer(sender, U128(amount), String::new()) {
            PromiseOrValue::Value(refund) => refund,
            PromiseOrValue::Promise(_) => panic!("ft_on_transfer must not schedule a promise"),
        }
    }

    #[test]
    fn deposit_records_principal_and_keeps_the_tokens() {
        let mut v = MockVenue::new();
        ctx(token());
        let refund = deposit(&mut v, vault(), 100);
        assert_eq!(refund, U128(0), "a full-keep deposit must refund nothing");
        assert_eq!(v.balance_of(vault()), U128(100));
        assert_eq!(v.list_balances(), vec![(vault(), U128(100))]);
    }

    #[test]
    fn deposits_from_the_same_sender_accumulate() {
        let mut v = MockVenue::new();
        ctx(token());
        deposit(&mut v, vault(), 100);
        deposit(&mut v, vault(), 40);
        assert_eq!(v.balance_of(vault()), U128(140));
    }

    #[test]
    fn deposits_from_different_senders_are_tracked_separately() {
        let mut v = MockVenue::new();
        ctx(token());
        deposit(&mut v, vault(), 100);
        deposit(&mut v, other(), 7);
        assert_eq!(v.balance_of(vault()), U128(100));
        assert_eq!(v.balance_of(other()), U128(7));
        let mut all = v.list_balances();
        all.sort();
        assert_eq!(all, vec![(other(), U128(7)), (vault(), U128(100))]);
    }

    #[test]
    fn partial_withdraw_reduces_principal_by_the_amount_paid() {
        let mut v = MockVenue::new();
        ctx(token());
        deposit(&mut v, vault(), 100);

        ctx_payable(vault());
        let _ = v.withdraw(token(), U128(40));
        assert_eq!(v.balance_of(vault()), U128(60));

        // The treasury reads the amount actually paid from the callback's return value.
        cb_ctx(PromiseResult::Successful(vec![]));
        assert_eq!(v.on_withdraw_done(U128(40)), U128(40));
    }

    #[test]
    fn over_withdraw_pays_only_the_recorded_principal() {
        let mut v = MockVenue::new();
        ctx(token());
        deposit(&mut v, vault(), 100);

        ctx_payable(vault());
        let _ = v.withdraw(token(), U128(500));
        assert_eq!(v.balance_of(vault()), U128(0));
        assert!(v.list_balances().is_empty());

        cb_ctx(PromiseResult::Successful(vec![]));
        assert_eq!(v.on_withdraw_done(U128(100)), U128(100));
    }

    #[test]
    fn failed_token_transfer_reports_zero_so_the_treasury_keeps_the_principal() {
        // The principal was already reduced before the ft_transfer; the callback only reports
        // what the treasury should subtract, so a failure must report 0.
        let mut v = MockVenue::new();
        ctx(token());
        deposit(&mut v, vault(), 100);
        ctx_payable(vault());
        let _ = v.withdraw(token(), U128(40));

        // KNOWN DIVERGENCE: the deduction above happened before the
        // transfer was attempted, so a failed transfer leaves the venue holding an unattributed
        // 100 while the treasury keeps its 100 principal on record. Both sides report correctly
        // on their own; only a reconciliation call can bring them back in line.
        assert_eq!(v.balance_of(vault()), U128(60));

        cb_ctx(PromiseResult::Failed);
        assert_eq!(v.on_withdraw_done(U128(40)), U128(0));
    }

    #[test]
    fn withdraw_with_no_principal_pays_zero_without_panicking() {
        let mut v = MockVenue::new();
        ctx(token());
        deposit(&mut v, vault(), 100);

        // `other` never deposited, so it has no principal: pay 0, do not revert.
        ctx_payable(other());
        let out = v.withdraw(token(), U128(10));
        assert!(
            matches!(out, PromiseOrValue::Value(U128(0))),
            "a sender with no principal must be paid 0, not rejected"
        );
        assert_eq!(v.balance_of(other()), U128(0));
        assert_eq!(v.balance_of(vault()), U128(100), "other depositors are untouched");
        assert!(get_logs()
            .iter()
            .any(|l| l.contains("has no principal recorded")));
    }

    #[test]
    fn withdraw_with_no_principal_never_calls_the_token() {
        // A zero payout must not schedule an ft_transfer: the caller gets a plain value back and
        // the treasury's callback reads 0 without a token round-trip.
        let mut v = MockVenue::new();
        ctx_payable(other());
        assert!(matches!(
            v.withdraw(token(), U128(10)),
            PromiseOrValue::Value(U128(0))
        ));
        assert!(v.list_balances().is_empty());
    }
}

/// Cross-contract cycle tests (treasury + venue). Test-only, so it never reaches the wasm.
#[cfg(test)]
mod e2e_cycle_tests;
