# Cold vault: design

Status: design and contract (`contracts/cold-vault`, unit-tested); not deployed.

## Problem

The operating treasury is built to move money: the AI proposes, the autonomy lane pays small
bills without approvals, and signers approve the rest. Everything it holds is exposed to whatever
goes wrong there: a manipulated prompt, a phished signer, a stolen laptop. A shop should not keep
its savings in the same place it pays bills from.

## Idea

Split the money. Most of it sits in a **cold vault** that can only send funds to one place (the
shop's own operating treasury), only when asked from **one registered device**, only after a
**delay** every guardian is alerted to, and only in **installments**.

```
checkout revenue ──sweep──> 80% cold vault ──(device request, 24 h delay, 4 daily installments)──┐
                    └─────> 20% operating treasury <───────────────────────────────────────────────┘
                                   └── AI proposals, autonomy lane, signer approvals (unchanged)
```

## Rules the contract enforces

| Rule | How |
|---|---|
| Only the registered device can ask for funds | `request_release` checks the transaction was signed with the registered public key (`env::signer_account_pk`) and sent directly, not through another contract. |
| Funds go to one place | Releases can only pay the operating treasury. There is no "send to" argument. |
| Everyone sees it coming | A request starts a delay; the keeper alerts guardians; any **one** guardian can cancel. |
| A breach is slow | A request pays out in installments, one per interval, with a weekly cap across requests. |
| One guardian can stop the bleeding | Any guardian can freeze the vault; unfreezing takes the guardian threshold. |
| Changing the rules is slow | New device key, new destination or new limits need the guardian threshold **and** a long delay, during which any guardian can cancel. |

Location is not a rule. A chain cannot tell where a device is, and a phone's GPS or IP address is
easy to fake. "Only at the office" is best achieved by keeping the device there: a hardware
wallet (Ledger) in the office safe holds the key.

## Numbers to decide (proposed defaults)

| Setting | Default | Range in contract | Trade-off |
|---|---|---|---|
| Revenue share to the vault | 80% | set in the sweep | Higher keeps more safe; lower means more requests. |
| Release delay | 24 h | 1 h to 14 days | Longer gives guardians more time; shorter for urgent needs. |
| Installments per request | 4 | 1 to 30 | More slices limit a breach; fewer is faster. |
| Installment interval | 24 h | 1 h to 7 days | |
| Weekly release cap | 25% of a typical month's revenue | any, 0 = none | The hard ceiling on loss per week (7-day periods in UTC, starting Thursday 00:00). |
| Rule-change delay | 7 days | 1 to 30 days | Covers a guardian on holiday. |
| Guardians / threshold | the treasury's signers, 2-of-2 | 1 to 10 | Cancel and freeze need one; changes need the threshold. |

With the defaults, the worst case for a stolen device whose theft nobody notices is one quarter
of a request per day, after a full day's warning, capped per week, and only into the shop's own
operating treasury, where the existing approvals still apply.

## Threat model

- **Covered:** compromised AI or prompt; one phished or malicious guardian (they can cancel or
  freeze, not move funds); a stolen laptop; a stolen device with alert guardians.
- **Limited, not prevented:** a stolen device plus guardians who all miss the alerts (bounded by
  installments and the weekly cap); coercion of the device holder (the delay buys time).
- **Not covered:** a threshold of guardians colluding over the rule-change delay; a bug in the
  vault or token contract (needs an audit before mainnet funds).

## Lost device

Guardians propose a new device key with the threshold; it takes effect after the rule-change
delay. Pending requests from the old key can be cancelled meanwhile.

## Out of scope for v1

On-chain revenue splitting (the sweep script applies the split), multiple tokens per vault,
passkeys/WebAuthn (NEAR keys are ed25519 or secp256k1; a hardware wallet covers the device case).

## Build and deploy (testnet)

`contracts/cold-vault`: 18 unit tests (`cargo test`). Deploy one vault per shop, signing with
your own keys; the device key is the public key of the device's NEAR access key (for a Ledger,
`near account add-key ... use-ledger` shows it).

```sh
RUSTFLAGS="-C link-arg=-s -C target-cpu=mvp" cargo build \
  --manifest-path contracts/cold-vault/Cargo.toml --target wasm32-unknown-unknown --release
near contract deploy vault.acme.testnet \
  use-file contracts/cold-vault/target/wasm32-unknown-unknown/release/cold_vault.wasm \
  with-init-call new json-args '{
    "token": "usdt.fakes.testnet", "destination": "acme.ghoststore.testnet",
    "guardians": ["alice.testnet", "bob.testnet"], "threshold": 2,
    "device_key": "ed25519:<device public key>",
    "limits": { "release_delay_ms": 86400000, "installments": 4,
                "installment_interval_ms": 86400000, "weekly_cap": "250000000",
                "change_delay_ms": 604800000 } }' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
# register the vault with the token so it can receive and send
near contract call-function as-transaction usdt.fakes.testnet storage_deposit \
  json-args '{"account_id":"vault.acme.testnet"}' prepaid-gas '30 Tgas' attached-deposit '0.0125 NEAR' \
  sign-as alice.testnet network-config testnet sign-with-keychain send
```

Revenue split: `SWEEP_VAULT_ID=vault.acme.near SWEEP_VAULT_SHARE=80 npm run sweep` (in `agent/`);
the vault's share is sent with `ft_transfer_call` so the vault books it.

## Next

- **Keeper:** call `release` for due installments and alert guardians on every new request,
  freeze and rule change (the delay is only as good as the alert).
- **Web:** a vault page: balance, pending requests with Cancel, Freeze, and a "Request funds"
  form that only works when signed from the device.
