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
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        _msg: String,
    ) -> PromiseOrValue<U128> {
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
    ///
    /// Requires 1 yoctoNEAR attached (forwarded to the ft_transfer call).
    #[payable]
    pub fn withdraw(&mut self, token_id: AccountId, amount: U128) -> Promise {
        require!(
            env::attached_deposit() >= ONE_YOCTO,
            "requires 1 yoctoNEAR"
        );

        let caller = env::predecessor_account_id();
        let principal = self.balances.get(&caller).copied().unwrap_or(0);
        require!(principal > 0, "no balance to withdraw");

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
        Promise::new(token_id)
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
            )
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
