use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

const DEVICE: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
const OTHER: &str = "ed25519:7PGseFbWxvYVgZ89K1uTJKYoKetWs7BJtbyXDzfbAcqX";
const T0_MS: u64 = 1_800_000_000_000;

fn vault() -> AccountId {
    "vault.acme.testnet".parse().unwrap()
}
fn token() -> AccountId {
    "usdt.testnet".parse().unwrap()
}
fn treasury() -> AccountId {
    "acme.ghoststore.testnet".parse().unwrap()
}
fn alice() -> AccountId {
    "alice.testnet".parse().unwrap()
}
fn bob() -> AccountId {
    "bob.testnet".parse().unwrap()
}
fn owner_device() -> AccountId {
    "safe-ledger.testnet".parse().unwrap()
}
fn eve() -> AccountId {
    "eve.testnet".parse().unwrap()
}

fn limits() -> Limits {
    Limits {
        release_delay_ms: DAY_MS,
        installments: 4,
        installment_interval_ms: DAY_MS,
        weekly_cap: U128(300),
        change_delay_ms: 7 * DAY_MS,
    }
}

/// A call from `predecessor`, signed by `signer` with key `pk`, at T0 + `at_ms`.
fn ctx_full(predecessor: AccountId, signer: AccountId, pk: &str, at_ms: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(vault())
        .predecessor_account_id(predecessor)
        .signer_account_id(signer)
        .signer_account_pk(pk.parse().unwrap())
        .attached_deposit(NearToken::from_yoctonear(0))
        .block_timestamp((T0_MS + at_ms) * 1_000_000)
        .build());
}

fn as_(who: AccountId, at_ms: u64) {
    ctx_full(who.clone(), who, OTHER, at_ms);
}

fn device(at_ms: u64) {
    ctx_full(owner_device(), owner_device(), DEVICE, at_ms);
}

fn callback(result: PromiseResult, at_ms: u64) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(vault())
            .block_timestamp((T0_MS + at_ms) * 1_000_000)
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

/// A vault holding 1000, guarded 2-of-2 by alice and bob.
fn setup() -> ColdVault {
    as_(alice(), 0);
    let mut v = ColdVault::new(token(), treasury(), vec![alice(), bob()], 2, DEVICE.parse().unwrap(), limits());
    as_(token(), 0);
    let _ = v.ft_on_transfer(alice(), U128(1000), String::new());
    v
}

fn release_ok(v: &mut ColdVault, id: u64, at_ms: u64) -> u128 {
    as_(eve(), at_ms);
    let _ = v.release(id);
    let receipts = get_created_receipts();
    let call = receipts.iter().find(|r| r.receiver_id == token()).expect("ft_transfer to the token");
    let amount = match &call.actions[0] {
        MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } => {
            assert_eq!(method_name, b"ft_transfer");
            assert_eq!(*attached_deposit, NearToken::from_yoctonear(1));
            let a: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
            assert_eq!(a["receiver_id"], "acme.ghoststore.testnet", "only ever to the destination");
            a["amount"].as_str().unwrap().parse::<u128>().unwrap()
        }
        other => panic!("unexpected {other:?}"),
    };
    callback(PromiseResult::Successful(vec![]), at_ms);
    assert!(v.on_released(id, U128(amount), (T0_MS + at_ms) / WEEK_MS));
    amount
}

// ---- deposits -----------------------------------------------------------------------

#[test]
fn deposits_count_only_from_the_token() {
    let v = setup();
    assert_eq!(v.get_status().held, U128(1000));
    assert_eq!(v.get_status().available, U128(1000));
}

#[test]
#[should_panic(expected = "only the vault's token")]
fn fake_deposits_are_rejected() {
    let mut v = setup();
    as_(eve(), 0);
    let _ = v.ft_on_transfer(eve(), U128(1_000_000), String::new());
}

// ---- the device ---------------------------------------------------------------------

#[test]
fn the_device_can_request() {
    let mut v = setup();
    device(0);
    let id = v.request_release(U128(200), "payroll".into());
    let r = v.get_request(id).unwrap();
    assert_eq!(r.status, RequestStatus::Pending);
    assert_eq!(r.first_release_at_ms, T0_MS + DAY_MS);
    assert_eq!(v.get_status().committed, U128(200));
    assert_eq!(v.get_status().available, U128(800));
}

#[test]
#[should_panic(expected = "not signed by the registered device")]
fn a_guardian_without_the_device_cannot_request() {
    let mut v = setup();
    as_(alice(), 0);
    v.request_release(U128(200), "".into());
}

#[test]
#[should_panic(expected = "call directly")]
fn the_device_key_cannot_be_relayed_through_a_contract() {
    let mut v = setup();
    ctx_full(eve(), owner_device(), DEVICE, 0);
    v.request_release(U128(200), "".into());
}

#[test]
#[should_panic(expected = "more than the vault can commit")]
fn requests_cannot_exceed_uncommitted_funds() {
    let mut v = setup();
    device(0);
    v.request_release(U128(700), "".into());
    v.request_release(U128(301), "".into());
}

// ---- delay, installments, weekly cap ------------------------------------------------

#[test]
#[should_panic(expected = "no installment is due yet")]
fn nothing_is_released_before_the_delay() {
    let mut v = setup();
    device(0);
    let id = v.request_release(U128(200), "".into());
    as_(eve(), DAY_MS - 1);
    let _ = v.release(id);
}

#[test]
fn pays_in_installments_one_per_interval() {
    let mut v = setup();
    device(0);
    let id = v.request_release(U128(202), "".into());

    assert_eq!(release_ok(&mut v, id, DAY_MS), 50);
    // The next slice is not due until a day later.
    as_(eve(), DAY_MS + 1);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = v.release(id);
    }));
    assert!(r.is_err(), "second slice must wait an interval");

    assert_eq!(release_ok(&mut v, id, 2 * DAY_MS), 50);
    assert_eq!(release_ok(&mut v, id, 3 * DAY_MS), 50);
    assert_eq!(release_ok(&mut v, id, 4 * DAY_MS), 52, "last slice takes the remainder");

    let req = v.get_request(id).unwrap();
    assert_eq!(req.status, RequestStatus::Completed);
    assert_eq!(req.paid, U128(202));
    let s = v.get_status();
    assert_eq!(s.held, U128(798));
    assert_eq!(s.committed, U128(0));
}

#[test]
#[should_panic(expected = "weekly release cap reached")]
fn the_weekly_cap_holds_across_requests() {
    let mut v = setup();
    device(0);
    let a = v.request_release(U128(400), "".into());
    let b = v.request_release(U128(400), "".into());
    // T0 + 1 and 2 days fall in the same week: 100 + 100 + 100 = 300 = cap, so the fourth
    // slice must wait for the next week.
    assert_eq!((T0_MS + DAY_MS) / WEEK_MS, (T0_MS + 2 * DAY_MS) / WEEK_MS);
    release_ok(&mut v, a, DAY_MS);
    release_ok(&mut v, b, DAY_MS);
    release_ok(&mut v, a, 2 * DAY_MS);
    as_(eve(), 2 * DAY_MS);
    let _ = v.release(b);
}

#[test]
fn a_failed_transfer_rolls_back_so_it_can_be_retried() {
    let mut v = setup();
    device(0);
    let id = v.request_release(U128(100), "".into());
    as_(eve(), DAY_MS);
    let _ = v.release(id);
    assert_eq!(v.get_status().held, U128(975));
    callback(PromiseResult::Failed, DAY_MS);
    assert!(!v.on_released(id, U128(25), (T0_MS + DAY_MS) / WEEK_MS));

    let r = v.get_request(id).unwrap();
    assert_eq!(r.installments_paid, 0);
    assert_eq!(r.paid, U128(0));
    let s = v.get_status();
    assert_eq!(s.held, U128(1000));
    assert_eq!(s.committed, U128(100));
    assert_eq!(s.released_this_week, U128(0));
    assert_eq!(release_ok(&mut v, id, DAY_MS), 25, "retry succeeds");
}

// ---- one guardian can stop ----------------------------------------------------------

#[test]
fn any_one_guardian_cancels_a_request() {
    let mut v = setup();
    device(0);
    let id = v.request_release(U128(200), "".into());
    release_ok(&mut v, id, DAY_MS);
    as_(bob(), DAY_MS + 5);
    v.cancel_request(id);
    let r = v.get_request(id).unwrap();
    assert_eq!(r.status, RequestStatus::Cancelled);
    assert_eq!(r.cancelled_by, Some(bob()));
    assert_eq!(v.get_status().committed, U128(0));
    assert_eq!(v.get_status().available, U128(950));
}

#[test]
#[should_panic(expected = "only a guardian")]
fn outsiders_cannot_cancel() {
    let mut v = setup();
    device(0);
    let id = v.request_release(U128(200), "".into());
    as_(eve(), 5);
    v.cancel_request(id);
}

#[test]
fn freeze_blocks_requests_and_releases_until_the_threshold_unfreezes() {
    let mut v = setup();
    device(0);
    let id = v.request_release(U128(200), "".into());
    as_(alice(), 10);
    v.freeze();

    as_(eve(), DAY_MS);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = v.release(id);
    }))
    .is_err());
    device(DAY_MS);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        v.request_release(U128(1), "".into());
    }))
    .is_err());

    as_(alice(), DAY_MS);
    assert!(!v.approve_unfreeze(), "one of two is not enough");
    as_(bob(), DAY_MS);
    assert!(v.approve_unfreeze());
    assert!(!v.get_status().frozen);
    assert_eq!(release_ok(&mut v, id, DAY_MS), 50);
}

// ---- rule changes: threshold + delay ------------------------------------------------

#[test]
fn a_new_device_needs_both_guardians_and_the_change_delay() {
    let mut v = setup();
    as_(alice(), 0);
    let c = v.propose_change(ChangeKind::SetDevice { key: OTHER.parse().unwrap() });
    assert_eq!(v.list_changes(None, None)[0].executable_after_ms, None, "one approval of two");

    as_(eve(), 8 * DAY_MS);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| v.apply_change(c))).is_err());

    as_(bob(), DAY_MS);
    v.approve_change(c);
    as_(eve(), DAY_MS + 7 * DAY_MS - 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| v.apply_change(c))).is_err());
    as_(eve(), DAY_MS + 7 * DAY_MS);
    v.apply_change(c);

    // The old device is locked out, the new one works.
    device(9 * DAY_MS);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        v.request_release(U128(10), "".into());
    }))
    .is_err());
    ctx_full(owner_device(), owner_device(), OTHER, 9 * DAY_MS);
    v.request_release(U128(10), "".into());
}

#[test]
#[should_panic(expected = "change is not pending")]
fn any_one_guardian_cancels_a_rule_change() {
    let mut v = setup();
    as_(alice(), 0);
    let c = v.propose_change(ChangeKind::SetDestination { account_id: eve() });
    as_(bob(), 0);
    v.approve_change(c);
    as_(bob(), DAY_MS);
    v.cancel_change(c);
    as_(eve(), 8 * DAY_MS);
    v.apply_change(c);
}

#[test]
fn guardian_changes_apply_after_the_delay() {
    let mut v = setup();
    as_(alice(), 0);
    let c = v.propose_change(ChangeKind::SetGuardians { guardians: vec![alice(), bob(), eve()], threshold: 2 });
    as_(bob(), 0);
    v.approve_change(c);
    as_(eve(), 7 * DAY_MS);
    v.apply_change(c);
    let s = v.get_status();
    assert_eq!(s.guardians.len(), 3);
    assert_eq!(s.threshold, 2);
}

#[test]
#[should_panic(expected = "installments must be 1 to 30")]
fn limits_are_validated() {
    let mut v = setup();
    as_(alice(), 0);
    v.propose_change(ChangeKind::SetLimits { limits: Limits { installments: 0, ..limits() } });
}

#[test]
#[should_panic(expected = "release delay must be 1 hour to 14 days")]
fn init_validates_limits() {
    as_(alice(), 0);
    ColdVault::new(token(), treasury(), vec![alice()], 1, DEVICE.parse().unwrap(), Limits { release_delay_ms: 0, ..limits() });
}
