//! End-to-end cycle tests: the real treasury code and the real mock-venue code in one process.
//!
//! Each test follows the call sequence a testnet run produces — propose/approve, the token's
//! `ft_transfer_call` landing on the venue, the venue's callback result flowing back into the
//! treasury, then a withdraw and its callback — by switching `testing_env!` between the two
//! contracts. Only the token contract itself is not executed: its promise results are injected
//! exactly where a NEP-141 transfer would deliver them.
//!
//! The wasm sandbox cannot run on this host (near-sandbox 2.14.0 requires GLIBC 2.38+), so this
//! is the closest thing to an on-chain cycle available here. The token is modelled in two steps:
//! the venue's `ft_on_transfer` returns its refund, and `ft_resolve_transfer` turns that into the
//! amount used, which is what `ft_transfer_call` resolves to and the treasury's callback reads.
//!
//! Lives in the venue crate rather than `treasury/tests/` so the venue's deployable wasm stays
//! `cdylib`-only: adding `rlib` to its crate-type grows the artifact from ~100 KB to ~144 KB.
//! Run with `cd contracts/mock-venue && cargo test --lib e2e_cycle`.

use crate::MockVenue;
use near_sdk::json_types::U128;
use near_sdk::serde_json;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, NearToken, PromiseOrValue, PromiseResult};
use treasury::{ProposalKind, Status, Treasury};

const TS_NS: u64 = 1_000_000_000_000;

fn vault() -> AccountId {
    "vault.testnet".parse().unwrap()
}
fn venue() -> AccountId {
    "venue.testnet".parse().unwrap()
}
fn token() -> AccountId {
    "usdt.testnet".parse().unwrap()
}
fn alice() -> AccountId {
    "alice.testnet".parse().unwrap()
}
fn bob() -> AccountId {
    "bob.testnet".parse().unwrap()
}
fn ai() -> AccountId {
    "ai.testnet".parse().unwrap()
}

/// Treasury call as `who`; the contract account is the vault so its callbacks and cross-contract
/// calls are addressed correctly.
fn tctx(who: AccountId) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(vault())
        .predecessor_account_id(who)
        .account_balance(NearToken::from_near(10))
        .block_timestamp(TS_NS)
        .build());
}

/// Treasury callback context with one promise result.
fn tcb(result: PromiseResult) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(vault())
            .account_balance(NearToken::from_near(10))
            .block_timestamp(TS_NS)
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

/// Venue call from `predecessor`; `attached` is in yoctoNEAR (withdraw requires 1).
fn vctx(predecessor: AccountId, attached: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(venue())
        .predecessor_account_id(predecessor)
        .attached_deposit(NearToken::from_yoctonear(attached))
        .block_timestamp(TS_NS)
        .build());
}

fn ok_u128(v: u128) -> PromiseResult {
    PromiseResult::Successful(serde_json::to_vec(&U128(v)).unwrap())
}

/// 2-of-2: alice approves, bob's approval reaches the threshold.
fn approve_both(t: &mut Treasury, id: u64) {
    tctx(alice());
    assert!(
        t.approve(id).is_none(),
        "the first of two approvals must not execute"
    );
    tctx(bob());
    let _ = t.approve(id);
}

fn propose_and_pass(t: &mut Treasury, who: AccountId, kind: ProposalKind) -> u64 {
    tctx(who);
    let id = t.propose(kind, "e2e".into());
    approve_both(t, id);
    id
}

/// Treasury + venue configured the way the runbook does it: a 500 USDT venue cap, a 1000 USDT
/// total cap and a 100 USDT reserve floor.
fn setup() -> (Treasury, MockVenue) {
    tctx(alice());
    let mut t = Treasury::new(vec![alice(), bob()], 2, ai());
    propose_and_pass(
        &mut t,
        alice(),
        ProposalKind::SetVenueCap {
            venue: venue(),
            cap: U128(500),
        },
    );
    propose_and_pass(
        &mut t,
        alice(),
        ProposalKind::SetPolicy {
            stable_token: token(),
            max_total_allocated: U128(1_000),
            reserve_floor: U128(100),
        },
    );
    (t, MockVenue::new())
}

fn allocate(t: &mut Treasury, amount: u128) -> u64 {
    propose_and_pass(
        t,
        ai(),
        ProposalKind::Allocate {
            venue: venue(),
            token: token(),
            amount: U128(amount),
        },
    )
}

fn withdraw_proposal(t: &mut Treasury, amount: u128) -> u64 {
    propose_and_pass(
        t,
        ai(),
        ProposalKind::Withdraw {
            venue: venue(),
            amount: U128(amount),
        },
    )
}

/// The token contract executing `ft_transfer_call`: it calls the venue's `ft_on_transfer` with
/// the treasury as `sender_id` and gets back the amount the venue did not use.
fn token_deposits(v: &mut MockVenue, amount: u128) -> U128 {
    vctx(token(), 0);
    match v.ft_on_transfer(vault(), U128(amount), String::new()) {
        PromiseOrValue::Value(refund) => refund,
        PromiseOrValue::Promise(_) => panic!("ft_on_transfer must not schedule a promise"),
    }
}

/// The token's `ft_resolve_transfer` step (NEP-141): `ft_transfer_call` resolves to the amount
/// the receiver USED, i.e. `amount - refund`, and that is what the treasury's callback receives.
fn token_resolves(amount: u128, refund: U128) -> u128 {
    amount - refund.0.min(amount)
}

// ---- the allocation cycle ----------------------------------------------------

#[test]
fn allocation_cycle_books_the_principal_on_both_sides() {
    let (mut t, mut v) = setup();

    let id = allocate(&mut t, 200);
    let refund = token_deposits(&mut v, 200);
    assert_eq!(refund, U128(0), "the mock venue keeps everything");

    tcb(ok_u128(token_resolves(200, refund)));
    t.on_allocate_complete(id, venue(), U128(200));

    assert_eq!(t.get_proposal(id).unwrap().status, Status::Executed);
    assert_eq!(t.get_positions(), vec![(venue(), U128(200))]);
    assert_eq!(t.get_total_allocated(), U128(200));
    assert_eq!(v.balance_of(vault()), U128(200));
    assert_eq!(t.get_outflow_in_flight(), U128(0));
}

#[test]
fn allocation_cycle_books_only_what_the_venue_kept() {
    // A venue that refunds 50 of 200: the token resolves to 150 used.
    let (mut t, _v) = setup();
    let id = allocate(&mut t, 200);
    tcb(ok_u128(token_resolves(200, U128(50))));
    t.on_allocate_complete(id, venue(), U128(200));

    assert_eq!(t.get_proposal(id).unwrap().status, Status::Executed);
    assert_eq!(t.get_positions(), vec![(venue(), U128(150))]);
    assert_eq!(t.get_total_allocated(), U128(150));
}

#[test]
fn allocation_cycle_refused_by_the_venue_is_failed_and_written_off() {
    // A venue that refunds everything: the token resolves to 0 used.
    let (mut t, _v) = setup();
    let id = allocate(&mut t, 200);
    tcb(ok_u128(token_resolves(200, U128(200))));
    t.on_allocate_complete(id, venue(), U128(200));

    assert_eq!(t.get_proposal(id).unwrap().status, Status::Failed);
    assert_eq!(t.get_positions(), vec![]);
    assert_eq!(t.get_total_allocated(), U128(0));
}

#[test]
fn stale_position_withdraw_cycle_pays_zero_and_keeps_the_principal() {
    // A position the venue has no record of: e.g. after the venue lost or reset its books. The withdraw must not panic and must not write anything off.
    let (mut t, mut v) = setup();
    let id = allocate(&mut t, 200);
    tcb(ok_u128(200));
    t.on_allocate_complete(id, venue(), U128(200));
    assert_eq!(
        t.get_positions(),
        vec![(venue(), U128(200))],
        "the treasury believes 200 is supplied"
    );
    assert!(v.list_balances().is_empty(), "the venue has no record");

    let wid = withdraw_proposal(&mut t, 500);
    // Treasury -> venue.withdraw(token, 500) with 1 yoctoNEAR attached.
    vctx(vault(), 1);
    let out = v.withdraw(token(), U128(500));
    assert!(
        matches!(out, PromiseOrValue::Value(U128(0))),
        "a venue with no recorded principal pays 0 instead of reverting"
    );

    // Venue -> treasury callback: paid 0.
    tcb(ok_u128(0));
    t.on_withdraw_complete(wid, venue(), U128(500));

    assert_eq!(t.get_proposal(wid).unwrap().status, Status::Failed);
    assert_eq!(
        t.get_positions(),
        vec![(venue(), U128(200))],
        "nothing was written off"
    );
    assert!(v.list_balances().is_empty(), "the venue still owes nothing");
}
