use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

fn factory_id() -> AccountId {
    "ghoststore.testnet".parse().unwrap()
}
fn owner() -> AccountId {
    "owner.testnet".parse().unwrap()
}
fn ai() -> AccountId {
    "ai.testnet".parse().unwrap()
}
fn alice() -> AccountId {
    "alice.testnet".parse().unwrap()
}
fn bob() -> AccountId {
    "bob.testnet".parse().unwrap()
}
fn acme() -> AccountId {
    "acme.ghoststore.testnet".parse().unwrap()
}

const HASH: &str = "4mZ7pDSLjT1F7dNBFtPj7xTnuNfpZK6K3LyyWEkkDfaV";

fn ctx(who: AccountId, deposit: NearToken) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(factory_id())
        .predecessor_account_id(who)
        .attached_deposit(deposit)
        .account_balance(NearToken::from_near(20))
        .block_timestamp(1_000_000_000_000)
        .build());
}

fn callback(result: PromiseResult) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(factory_id())
            .predecessor_account_id(factory_id())
            .account_balance(NearToken::from_near(20))
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn setup() -> Factory {
    ctx(owner(), NearToken::from_near(0));
    Factory::new(owner(), HASH.parse().unwrap(), ai())
}

fn create(f: &mut Factory, who: AccountId, name: &str, signers: Vec<AccountId>, threshold: u32) {
    ctx(who, NearToken::from_near(1));
    let _ = f.create_treasury(name.into(), signers, threshold, "Acme Coffee".into(), Some("acme.near".into()));
}

#[test]
fn shop_names() {
    for ok in ["acme", "ab", "acme-coffee", "shop_42", "a1"] {
        assert!(valid_shop_name(ok), "{ok}");
    }
    for bad in ["a", "Acme", "-acme", "acme-", "ac.me", "acme coffee", "", &"x".repeat(33)] {
        assert!(!valid_shop_name(bad), "{bad}");
    }
}

#[test]
fn create_builds_one_batch_that_creates_funds_uses_the_global_code_and_inits() {
    let mut f = setup();
    create(&mut f, alice(), "acme", vec![alice(), bob()], 2);

    let receipts = get_created_receipts();
    let batch = receipts.iter().find(|r| r.receiver_id == acme()).expect("batch to the shop account");
    let a = &batch.actions;
    assert!(matches!(a[0], MockAction::CreateAccount { .. }));
    match &a[1] {
        MockAction::Transfer { deposit, .. } => assert_eq!(*deposit, NearToken::from_near(1).saturating_sub(RECORD_FEE)),
        other => panic!("expected transfer, got {other:?}"),
    }
    assert!(matches!(a[2], MockAction::UseGlobalContract { .. }));
    match &a[3] {
        MockAction::FunctionCallWeight { method_name, args, .. } => {
            assert_eq!(method_name, b"new");
            let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
            assert_eq!(v["signers"], json!(["alice.testnet", "bob.testnet"]));
            assert_eq!(v["threshold"], json!(2));
            assert_eq!(v["proposer"], json!("ai.testnet"));
        }
        other => panic!("expected new(), got {other:?}"),
    }
    assert!(receipts.iter().any(|r| r.receiver_id == factory_id()), "callback scheduled");

    let shop = f.get_shop(acme()).unwrap();
    assert_eq!(shop.status, ShopStatus::Creating);
    assert!(!f.is_available("acme".into()), "name reserved while in flight");
}

#[test]
fn successful_creation_activates_and_lists_the_shop() {
    let mut f = setup();
    create(&mut f, alice(), "acme", vec![alice(), bob()], 2);
    callback(PromiseResult::Successful(vec![]));
    assert!(f.on_treasury_created(acme(), alice(), NearToken::from_near(1)));

    assert_eq!(f.get_shop(acme()).unwrap().status, ShopStatus::Active);
    assert_eq!(f.shops_of(alice()).len(), 1);
    assert_eq!(f.shops_of(bob()).len(), 0, "bob did not create it");
    assert_eq!(f.shops_signed_by(bob()).len(), 1, "but bob signs for it");
    assert_eq!(f.list_shops(None, None).len(), 1);
    assert_eq!(f.get_config().shop_count, 1);
}

#[test]
fn failed_creation_frees_the_name_and_refunds_the_creator() {
    let mut f = setup();
    create(&mut f, alice(), "acme", vec![alice()], 1);
    callback(PromiseResult::Failed);
    assert!(!f.on_treasury_created(acme(), alice(), NearToken::from_near(1)));

    assert!(f.get_shop(acme()).is_none());
    assert!(f.is_available("acme".into()));
    assert!(f.shops_of(alice()).is_empty());
    let refund = get_created_receipts()
        .into_iter()
        .find(|r| r.receiver_id == alice())
        .expect("refund to the creator");
    assert!(matches!(refund.actions[0], MockAction::Transfer { deposit, .. } if deposit == NearToken::from_near(1)));
}

#[test]
fn duplicate_signers_are_collapsed() {
    let mut f = setup();
    create(&mut f, alice(), "acme", vec![alice(), bob(), alice()], 2);
    assert_eq!(f.get_shop(acme()).unwrap().signers, vec![alice(), bob()]);
}

#[test]
#[should_panic(expected = "that shop name is taken")]
fn names_are_unique() {
    let mut f = setup();
    create(&mut f, alice(), "acme", vec![alice()], 1);
    create(&mut f, bob(), "acme", vec![bob()], 1);
}

#[test]
#[should_panic(expected = "attach at least 0.5 NEAR")]
fn requires_the_minimum_deposit() {
    let mut f = setup();
    ctx(alice(), NearToken::from_millinear(499));
    let _ = f.create_treasury("acme".into(), vec![alice()], 1, "Acme".into(), None);
}

#[test]
#[should_panic(expected = "the caller must be one of the signers")]
fn caller_must_be_a_signer() {
    let mut f = setup();
    create(&mut f, alice(), "acme", vec![bob()], 1);
}

#[test]
#[should_panic(expected = "threshold must be 1..=signers")]
fn threshold_cannot_exceed_signers() {
    let mut f = setup();
    create(&mut f, alice(), "acme", vec![alice(), bob()], 3);
}

#[test]
#[should_panic(expected = "threshold must be 1..=signers")]
fn threshold_cannot_be_zero() {
    let mut f = setup();
    create(&mut f, alice(), "acme", vec![alice()], 0);
}

#[test]
#[should_panic(expected = "the AI proposer cannot be a signer")]
fn the_ai_cannot_sign() {
    let mut f = setup();
    create(&mut f, alice(), "acme", vec![alice(), ai()], 1);
}

#[test]
#[should_panic(expected = "name: 2-32 lowercase")]
fn rejects_bad_names() {
    let mut f = setup();
    create(&mut f, alice(), "Acme!", vec![alice()], 1);
}

#[test]
#[should_panic(expected = "display name")]
fn requires_a_display_name() {
    let mut f = setup();
    ctx(alice(), NearToken::from_near(1));
    let _ = f.create_treasury("acme".into(), vec![alice()], 1, "   ".into(), None);
}

#[test]
#[should_panic(expected = "only the factory owner")]
fn only_the_owner_changes_the_code_hash() {
    let mut f = setup();
    ctx(alice(), NearToken::from_near(0));
    f.set_treasury_code_hash(HASH.parse().unwrap());
}

#[test]
fn owner_can_update_config() {
    let mut f = setup();
    ctx(owner(), NearToken::from_near(0));
    f.set_default_proposer(bob());
    f.set_owner(alice());
    let c = f.get_config();
    assert_eq!(c.default_proposer, bob());
    assert_eq!(c.owner, alice());
}

#[test]
fn payout_accounts() {
    for ok in ["acme.near", "shop.acme.near", &"a".repeat(64), &"0123456789abcdef".repeat(4)] {
        assert!(valid_payout_account(ok), "{ok}");
    }
    for bad in ["acme.testnet", "acme", "ACME.near", ".near", &"g".repeat(64), "0x5Ce7a697d2710275e14179E8D62C816628737A6b"] {
        assert!(!valid_payout_account(bad), "{bad}");
    }
}

fn active_acme() -> Factory {
    let mut f = setup();
    create(&mut f, alice(), "acme", vec![alice(), bob()], 2);
    callback(PromiseResult::Successful(vec![]));
    f.on_treasury_created(acme(), alice(), NearToken::from_near(1));
    f
}

#[test]
fn creator_sets_the_payout_account() {
    let mut f = active_acme();
    assert_eq!(f.get_shop(acme()).unwrap().payout_account.as_deref(), Some("acme.near"));
    ctx(alice(), NearToken::from_near(0));
    f.set_payout_account(acme(), Some("acme-coffee.near".into()));
    assert_eq!(f.get_shop(acme()).unwrap().payout_account.as_deref(), Some("acme-coffee.near"));
    f.set_payout_account(acme(), None);
    assert_eq!(f.get_shop(acme()).unwrap().payout_account, None);
}

#[test]
#[should_panic(expected = "only the shop's creator")]
fn a_co_signer_cannot_redirect_revenue() {
    let mut f = active_acme();
    ctx(bob(), NearToken::from_near(0));
    f.set_payout_account(acme(), Some("bob.near".into()));
}

#[test]
#[should_panic(expected = "payout account must be a mainnet")]
fn payout_account_must_be_mainnet() {
    let mut f = setup();
    ctx(alice(), NearToken::from_near(1));
    let _ = f.create_treasury("acme".into(), vec![alice()], 1, "Acme".into(), Some("acme.testnet".into()));
}
