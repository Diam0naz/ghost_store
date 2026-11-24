//! Ghost Store factory: one transaction gives a merchant their own treasury.
//!
//! `create_treasury("acme", signers, threshold, "Acme Coffee")` creates `acme.<factory>`, funds
//! it with the attached deposit, points it at the treasury code and calls the treasury's `new`.
//!
//! The treasury code is a NEAR global contract referenced by its **code hash**, not by an
//! account: the 470 KB wasm is stored once, a new shop pays only for its own state, and nobody,
//! the factory owner included, can swap the code under an existing shop. Changing the hash only
//! affects shops created afterwards.
//!
//! Policy, vendors, autonomy limits and the TEE model key are not set here: the shop's signers
//! set them through the treasury's own governance proposals, the same way as any treasury.

use near_sdk::json_types::Base58CryptoHash;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
};

/// Smallest deposit for a new shop: covers the treasury's initial state with room for its
/// first proposals and invoices. Anything above it also goes to the shop.
pub const MIN_DEPOSIT: NearToken = NearToken::from_millinear(500);
/// Kept by the factory to pay for the shop's directory record.
pub const RECORD_FEE: NearToken = NearToken::from_millinear(10);
const GAS_NEW: Gas = Gas::from_tgas(30);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);
pub const MAX_SIGNERS: usize = 10;

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Shops,
    ByOwner,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum ShopStatus {
    /// Creation receipts are in flight.
    Creating,
    Active,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Shop {
    pub treasury: AccountId,
    pub display_name: String,
    pub created_by: AccountId,
    pub signers: Vec<AccountId>,
    pub threshold: u32,
    pub proposer: AccountId,
    pub created_at_ms: u64,
    pub status: ShopStatus,
    /// Mainnet NEAR account that checkout pays (NEAR Intents settles on mainnet only, while
    /// shops run on testnet). `None` until the merchant sets one; checkout is off without it.
    pub payout_account: Option<String>,
}

#[near(serializers = [json])]
pub struct FactoryConfig {
    pub owner: AccountId,
    pub treasury_code_hash: Base58CryptoHash,
    pub default_proposer: AccountId,
    pub min_deposit: NearToken,
    pub shop_count: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    owner: AccountId,
    treasury_code_hash: Base58CryptoHash,
    /// The hosted Ghost Store agent's account; it may only propose, never approve.
    default_proposer: AccountId,
    shops: IterableMap<AccountId, Shop>,
    by_owner: LookupMap<AccountId, Vec<AccountId>>,
}

/// A mainnet NEAR account checkout can pay: a named `.near` account or a 64-hex implicit one.
pub fn valid_payout_account(id: &str) -> bool {
    if id.len() == 64 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        return true;
    }
    id.ends_with(".near") && id.parse::<AccountId>().is_ok()
}

/// Lowercase letters, digits, `-` and `_`, 2 to 32 characters, no leading or trailing separator.
pub fn valid_shop_name(name: &str) -> bool {
    let b = name.as_bytes();
    (2..=32).contains(&b.len())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-' || *c == b'_')
        && b[0].is_ascii_alphanumeric()
        && b[b.len() - 1].is_ascii_alphanumeric()
}

#[near]
impl Factory {
    #[init]
    pub fn new(owner: AccountId, treasury_code_hash: Base58CryptoHash, default_proposer: AccountId) -> Self {
        Self {
            owner,
            treasury_code_hash,
            default_proposer,
            shops: IterableMap::new(Key::Shops),
            by_owner: LookupMap::new(Key::ByOwner),
        }
    }

    // ---- merchant entry point ------------------------------------------------

    /// Create `<name>.<factory>` as a treasury governed by `signers` (M-of-N with `threshold`).
    /// The caller must be one of the signers. Attach at least `MIN_DEPOSIT`.
    #[payable]
    pub fn create_treasury(
        &mut self,
        name: String,
        signers: Vec<AccountId>,
        threshold: u32,
        display_name: String,
        payout_account: Option<String>,
    ) -> Promise {
        let creator = env::predecessor_account_id();
        let deposit = env::attached_deposit();
        require!(deposit >= MIN_DEPOSIT, "attach at least 0.5 NEAR for the new treasury");
        require!(valid_shop_name(&name), "name: 2-32 lowercase letters, digits, - or _");
        let display_name = display_name.trim().to_string();
        require!(!display_name.is_empty() && display_name.len() <= 64, "display name: 1-64 characters");
        if let Some(p) = &payout_account {
            require!(valid_payout_account(p), "payout account must be a mainnet .near or implicit account");
        }

        let mut uniq: Vec<AccountId> = Vec::new();
        for s in signers {
            if !uniq.contains(&s) {
                uniq.push(s);
            }
        }
        require!(!uniq.is_empty() && uniq.len() <= MAX_SIGNERS, "1-10 distinct signers");
        require!(uniq.contains(&creator), "the caller must be one of the signers");
        require!(threshold >= 1 && threshold as usize <= uniq.len(), "threshold must be 1..=signers");
        require!(!uniq.contains(&self.default_proposer), "the AI proposer cannot be a signer");

        let treasury: AccountId = format!("{name}.{}", env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("invalid account id"));
        require!(!self.shops.contains_key(&treasury), "that shop name is taken");

        // Reserve the name now so two concurrent calls cannot both create it.
        self.shops.insert(
            treasury.clone(),
            Shop {
                treasury: treasury.clone(),
                display_name,
                created_by: creator.clone(),
                signers: uniq.clone(),
                threshold,
                proposer: self.default_proposer.clone(),
                created_at_ms: env::block_timestamp_ms(),
                status: ShopStatus::Creating,
                payout_account,
            },
        );

        let funding = deposit.saturating_sub(RECORD_FEE);
        let code_hash: [u8; 32] = self.treasury_code_hash.into();
        Promise::new(treasury.clone())
            .create_account()
            .transfer(funding)
            .use_global_contract(code_hash)
            .function_call(
                "new".to_string(),
                json!({ "signers": uniq, "threshold": threshold, "proposer": self.default_proposer })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_NEW,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_treasury_created(treasury, creator, deposit),
            )
    }

    /// Activates the shop, or frees the name and refunds the creator if creation failed.
    /// (When the batch fails, its attached funds come back to the factory first.)
    #[private]
    pub fn on_treasury_created(
        &mut self,
        treasury: AccountId,
        creator: AccountId,
        deposit: NearToken,
    ) -> bool {
        match env::promise_result_checked(0, 64) {
            Ok(_) => {
                if let Some(shop) = self.shops.get_mut(&treasury) {
                    shop.status = ShopStatus::Active;
                }
                let mut mine = self.by_owner.get(&creator).cloned().unwrap_or_default();
                mine.push(treasury.clone());
                self.by_owner.insert(creator, mine);
                env::log_str(&format!("shop created: {treasury}"));
                true
            }
            Err(_) => {
                self.shops.remove(&treasury);
                Promise::new(creator).transfer(deposit).detach();
                env::log_str(&format!("shop creation failed, deposit refunded: {treasury}"));
                false
            }
        }
    }

    /// Set or clear the mainnet account checkout pays. Only the shop's creator may change it, so
    /// one co-signer alone cannot redirect the shop's revenue; every change is logged.
    pub fn set_payout_account(&mut self, treasury: AccountId, payout_account: Option<String>) {
        let caller = env::predecessor_account_id();
        let shop = self.shops.get_mut(&treasury).unwrap_or_else(|| env::panic_str("no such shop"));
        require!(shop.status == ShopStatus::Active, "shop is not active yet");
        require!(caller == shop.created_by, "only the shop's creator can change its payout account");
        if let Some(p) = &payout_account {
            require!(valid_payout_account(p), "payout account must be a mainnet .near or implicit account");
        }
        env::log_str(&format!(
            "payout account for {treasury}: {} -> {}",
            shop.payout_account.as_deref().unwrap_or("none"),
            payout_account.as_deref().unwrap_or("none")
        ));
        shop.payout_account = payout_account;
    }

    // ---- owner -----------------------------------------------------------------

    /// Point new shops at another treasury build. Existing shops keep their code.
    pub fn set_treasury_code_hash(&mut self, code_hash: Base58CryptoHash) {
        self.assert_owner();
        self.treasury_code_hash = code_hash;
    }

    pub fn set_default_proposer(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.default_proposer = account_id;
    }

    pub fn set_owner(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.owner = account_id;
    }

    // ---- views -----------------------------------------------------------------

    pub fn get_config(&self) -> FactoryConfig {
        FactoryConfig {
            owner: self.owner.clone(),
            treasury_code_hash: self.treasury_code_hash,
            default_proposer: self.default_proposer.clone(),
            min_deposit: MIN_DEPOSIT,
            shop_count: self.shops.len(),
        }
    }

    pub fn get_shop(&self, treasury: AccountId) -> Option<Shop> {
        self.shops.get(&treasury).cloned()
    }

    /// Shops created by `account_id` (active only).
    pub fn shops_of(&self, account_id: AccountId) -> Vec<Shop> {
        self.by_owner
            .get(&account_id)
            .map(|ids| ids.iter().filter_map(|t| self.shops.get(t).cloned()).collect())
            .unwrap_or_default()
    }

    /// Shops where `account_id` is a signer (active only). Scans the directory; fine for a
    /// directory of thousands, to be replaced by an indexer beyond that.
    pub fn shops_signed_by(&self, account_id: AccountId) -> Vec<Shop> {
        self.shops
            .values()
            .filter(|s| s.status == ShopStatus::Active && s.signers.contains(&account_id))
            .cloned()
            .collect()
    }

    pub fn list_shops(&self, from: Option<u32>, limit: Option<u32>) -> Vec<Shop> {
        self.shops
            .values()
            .skip(from.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .cloned()
            .collect()
    }

    /// True when `name` is well formed and not taken.
    pub fn is_available(&self, name: String) -> bool {
        valid_shop_name(&name)
            && format!("{name}.{}", env::current_account_id())
                .parse::<AccountId>()
                .map(|a| !self.shops.contains_key(&a))
                .unwrap_or(false)
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the factory owner");
    }
}

#[cfg(test)]
mod tests;
