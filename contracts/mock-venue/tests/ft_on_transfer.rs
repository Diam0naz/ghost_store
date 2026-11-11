//! Regression tests for the NEP-141 receiver.
//!
//! The treasury deposits with `ft_transfer_call`, so the token contract calls
//! `ft_on_transfer({"sender_id": ..., "amount": ..., "msg": ...})`. near-sdk derives JSON field
//! names from the Rust parameter names; an earlier `_msg` argument panicked every deposit with
//! `missing field _msg`.
//!
//! Two layers of coverage:
//!
//! 1. `ft_on_transfer_declares_the_exact_nep141_argument_names` reads the ABI that
//!    `cargo near build` generates from the `#[near]` wrapper and asserts the receiver's JSON
//!    argument names. This is the enforceable check on this host: the prebuilt `near-sandbox`
//!    binary (2.14.0) needs GLIBC 2.38+, which this Linux image does not have.
//! 2. `ft_on_transfer_accepts_the_exact_nep141_payload` is the end-to-end sandbox call against
//!    the real wasm. It is `#[ignore]`d because it cannot start a node here; run it with
//!    `cargo test -- --ignored` on a host with a newer glibc.
//!
//! Both need `cargo near build non-reproducible-wasm` in this crate first; the artefacts are not
//! committed. Without them each test reports a skip instead of failing.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const WASM: &str = "target/near/mock_venue.wasm";
const ABI: &str = "target/near/mock_venue_abi.json";

fn artefact(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)
}

/// The exact field names an NEP-141 token puts on the wire for `ft_transfer_call`.
const NEP141_ARGS: [&str; 3] = ["sender_id", "amount", "msg"];

#[test]
fn ft_on_transfer_declares_the_exact_nep141_argument_names() {
    let abi_path = artefact(ABI);
    let Ok(bytes) = std::fs::read(&abi_path) else {
        eprintln!(
            "SKIP: {} not built. Run `cargo near build non-reproducible-wasm` in contracts/mock-venue.",
            abi_path.display()
        );
        return;
    };
    let abi: Value = serde_json::from_slice(&bytes).expect("generated ABI is not valid JSON");
    let functions = abi["body"]["functions"]
        .as_array()
        .expect("ABI has no body.functions array");
    let receiver = functions
        .iter()
        .find(|f| f["name"] == "ft_on_transfer")
        .expect("ft_on_transfer is missing from the ABI");

    assert_eq!(
        receiver["params"]["serialization_type"], "json",
        "ft_on_transfer must take JSON arguments"
    );
    let args = receiver["params"]["args"]
        .as_array()
        .expect("ft_on_transfer has no JSON args");
    let names: Vec<&str> = args
        .iter()
        .map(|a| a["name"].as_str().expect("argument without a name"))
        .collect();
    assert_eq!(
        names, NEP141_ARGS,
        "ft_on_transfer must accept exactly the NEP-141 payload; near-sdk derives these names \
         from the Rust parameters, so a renamed argument (e.g. `_msg`) breaks every deposit"
    );

    // All three fields are strings on the wire: an AccountId, a U128 and a memo.
    for arg in args {
        assert_eq!(
            arg["type_schema"]["type"], "string",
            "argument `{}` must be a JSON string",
            arg["name"]
        );
    }
}

/// End-to-end: deploy the wasm in a sandbox and post the payload an NEP-141 token would send.
#[ignore = "near-sandbox 2.14.0 requires GLIBC 2.38+, unavailable on this host"]
#[tokio::test]
async fn ft_on_transfer_accepts_the_exact_nep141_payload() -> anyhow::Result<()> {
    let wasm_path = artefact(WASM);
    if !wasm_path.exists() {
        eprintln!(
            "SKIP: {} not built. Run `cargo near build non-reproducible-wasm` in contracts/mock-venue.",
            wasm_path.display()
        );
        return Ok(());
    }

    let sandbox = near_workspaces::sandbox().await?;
    let wasm = std::fs::read(&wasm_path)?;
    let venue = sandbox.dev_deploy(&wasm).await?;

    let init = venue.call("new").args_json(json!({})).transact().await?;
    assert!(init.is_success(), "new() failed: {:?}", init.failures());

    let depositor = sandbox.dev_create_account().await?;

    // The exact shape an NEP-141 token sends, with the field names spelled out.
    let deposit = venue
        .call("ft_on_transfer")
        .args_json(json!({
            "sender_id": depositor.id(),
            "amount": "1000000",
            "msg": ""
        }))
        .transact()
        .await?;
    assert!(
        deposit.is_success(),
        "ft_on_transfer rejected the NEP-141 payload: {:?}",
        deposit.failures()
    );

    // The venue keeps everything: the returned refund is 0, serialized as a U128 string.
    let refund: String = deposit.json()?;
    assert_eq!(refund, "0", "a full-keep deposit must refund nothing");

    let balance: String = venue
        .view("balance_of")
        .args_json(json!({ "account_id": depositor.id() }))
        .await?
        .json()?;
    assert_eq!(balance, "1000000", "principal was not recorded for sender_id");

    // A second deposit must accumulate, not overwrite.
    let deposit_again = venue
        .call("ft_on_transfer")
        .args_json(json!({
            "sender_id": depositor.id(),
            "amount": "500",
            "msg": ""
        }))
        .transact()
        .await?;
    assert!(deposit_again.is_success(), "{:?}", deposit_again.failures());

    let balance: String = venue
        .view("balance_of")
        .args_json(json!({ "account_id": depositor.id() }))
        .await?
        .json()?;
    assert_eq!(balance, "1000500");

    Ok(())
}
