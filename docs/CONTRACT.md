# Treasury contract reference

`contracts/treasury` — Rust, near-sdk 5 (`unstable` feature, for `env::ecrecover`). 101 unit tests
(`cd contracts/treasury && cargo test`, 101 passed / 0 failed when last run), including one that
verifies a real NEAR AI Cloud TEE signature (`src/real_vectors.rs`). Three cross-contract cycle tests (treasury + venue, driven
in-process) live in `contracts/mock-venue/src/e2e_cycle_tests.rs`: 2 pass, 1 is ignored because
it asserts the correct allocation accounting and fails against the current code.

Everything below was checked against the source in this repo and, where marked, against the
deployed contracts on NEAR testnet (state read on 2026-11-04). Anything not exercised on chain is
listed as untested rather than implied to work.

> **Deployment status (2026-11-10):** `vault.treasury-dev.testnet` still runs **v1** (no
> attested proposals, no autonomy lane). The v2 code in this repo is unit-tested but not yet
> deployed. Upgrade steps: [Upgrading testnet to v2](#upgrading-testnet-to-v2).

## Deployed contracts (testnet)

| Role | Account | Notes |
|---|---|---|
| Treasury contract | `vault.treasury-dev.testnet` | Code hash `DyTXiJZrNjsU…`. Holds the stablecoin balance. |
| Mock venue | `ghoststore-venue.testnet` | Code hash `EqJ6bBykbHcG…` (the build with the `msg` fix). Implements the venue interface below. Stores principal per depositor, pays no yield. |
| Stable token | `usdt.fakes.testnet` | NEP-141, symbol `USDT.e`, **6 decimals**. 1 USDT = `1000000` base units. |
| Signer 1 | `treasury-dev.testnet` | |
| Signer 2 | `cosigner.treasury-dev.testnet` | |
| Proposer (AI) | `ai-proposer.treasury-dev.testnet` | `propose` only; cannot approve, reject or pause. |

Dead accounts — do not point anything at them:

| Account | Why |
|---|---|
| `mock-venue.treasury-dev.testnet` | Earlier mock venue. Its deploy key was not saved and is gone; it was never running our current code. Proposal #2 (Allocate to it) is `Failed` with a full refund. |
| `mock-venue2.treasury-dev.testnet` | Created as a replacement but the wasm was never deployed (`code_hash` stayed `1111…`). Proposal #4 (Allocate to it) is `Failed` with a full refund. |

Current policy (`get_policy`, `get_venue_cap`):

| Setting | Value | Base units |
|---|---|---|
| `stable_token` | `usdt.fakes.testnet` | — |
| `max_total_allocated` | 1000 USDT | `1000000000` |
| `reserve_floor` | 100 USDT | `100000000` |
| Venue cap, `ghoststore-venue.testnet` | 500 USDT | `500000000` |
| `paused` | `false` | — |
| Signers / threshold | 2 signers, threshold 2 (2-of-2) | — |

At the time of writing the vault holds 400 USDT (`ft_balance_of` → `400000000`) and has no open
positions (`get_positions` → `[]`, `get_total_allocated` → `0`). That is the expected end state
after the run below: 400 minted, 200 allocated, 50 withdrawn, then 150 paid back by an
over-sized withdraw.

## Roles

| Role | Can | Cannot |
|---|---|---|
| `proposer` (AI service) | `propose`, `propose_attested` | approve, reject, pause, execute anything |
| `signers` (humans) | `propose`, `approve`, `reject` (one reject vetoes an autonomy-lane payout), `pause` | execute without reaching `threshold` |
| anyone | views, `expire` (stale proposals), `execute_auto` (autonomy-lane payouts after the veto window) | anything else state-changing |

Execution needs `threshold` approvals from accounts that are still signers when the threshold is
reached. Approvals from accounts removed in the meantime are not counted, but they are still
stored on the proposal.

## Proposal kinds

| Kind | Effect |
|---|---|
| `Payout { to, token, amount }` | Pay NEAR (`token: null`) or an NEP-141 token. Native payouts keep storage staking + 0.5 NEAR free. |
| `Allocate { venue, token, amount }` | Supply `stable_token` to a whitelisted venue via `ft_transfer_call`. Reserves the principal on approval, rolls it back if the balance check or transfer fails. |
| `Withdraw { venue, amount }` | Call the venue's `withdraw(token_id, amount)`. The venue caps the payout at the recorded principal, so an over-sized withdraw is safe. |
| `SetVenueCap { venue, cap }` | Whitelist a venue with a cumulative principal cap. `cap: 0` removes it from the whitelist. |
| `SetPolicy { stable_token, max_total_allocated, reserve_floor }` | Configure the yield layer. |
| `SetPaused { paused }` | Pause or unpause allocations. `pause()` itself is an instant single-signer action. |
| `AddSigner`, `RemoveSigner`, `SetThreshold`, `SetProposer` | Governance. |
| `SetModelSigner { address, model }` | Trust a NEAR AI TEE signing address (lowercase `0x` + 40 hex) for one model. `model: ""` revokes it. |
| `SetVendor { account_id, enabled }` | Add or remove a vendor on the autonomy allowlist. |
| `SetAutonomy { policy }` | Configure the autonomy lane (`token`, `max_per_payout`, `daily_cap`, `veto_window_ms` ≥ 60000, `invoices_only`), or `null` to turn it off. |
| `PayInvoice { invoice_id }` | Pay an open invoice's current holder its amount in its token. One pending proposal per invoice. |
| `SetFactoringFee { fee_bps, recipient }` | Fee on invoice sales (≤ 1000 bps); applies only when `recipient` is set. |

### JSON shapes (from the generated ABI, `contracts/treasury/target/near/treasury_abi.json`)

`ProposalKind` is an externally tagged enum: the variant name is the key, its fields the value.
All amounts are `U128` **strings** in base units; `id` is a `u64` JSON number.

```jsonc
{"Payout":{"to":"vendor.testnet","token":null,"amount":"5000000000000000000000000"}}   // native NEAR, yoctoNEAR
{"Payout":{"to":"vendor.testnet","token":"usdt.fakes.testnet","amount":"25000000"}}     // 25 USDT
{"Allocate":{"venue":"ghoststore-venue.testnet","token":"usdt.fakes.testnet","amount":"200000000"}}
{"Withdraw":{"venue":"ghoststore-venue.testnet","amount":"50000000"}}
{"SetVenueCap":{"venue":"ghoststore-venue.testnet","cap":"500000000"}}
{"SetPolicy":{"stable_token":"usdt.fakes.testnet","max_total_allocated":"1000000000","reserve_floor":"100000000"}}
{"SetPaused":{"paused":true}}
{"AddSigner":{"account_id":"new-signer.testnet"}}
{"RemoveSigner":{"account_id":"old-signer.testnet"}}
{"SetThreshold":{"threshold":2}}
{"SetProposer":{"account_id":"ai-proposer.treasury-dev.testnet"}}
{"SetModelSigner":{"address":"0xfdbd7952498b333206f360d71d97a1e0961e8ddf","model":"Qwen/Qwen3.6-35B-A3B-FP8"}}
{"SetVendor":{"account_id":"packaging.treasury-dev.testnet","enabled":true}}
{"SetAutonomy":{"policy":{"token":"usdt.fakes.testnet","max_per_payout":"50000000","daily_cap":"100000000","veto_window_ms":300000,"invoices_only":true}}}
{"PayInvoice":{"invoice_id":3}}
{"SetFactoringFee":{"fee_bps":50,"recipient":"treasury-dev.testnet"}}
```

`Payout.token` may be omitted entirely (it is optional in the schema; `null` is the explicit
native-NEAR form). `propose` takes `{"kind": <above>, "rationale": "<≤500 chars>"}`.

## v2: attested AI proposals and the autonomy lane

### `propose_attested(model, request_hash, response, signature) -> Vec<u64>`

Proposer only. Turns one TEE-signed NEAR AI Cloud completion into proposals.

| Argument | Meaning |
|---|---|
| `model` | Model id exactly as NEAR AI signs it, e.g. `Qwen/Qwen3.6-35B-A3B-FP8`. |
| `request_hash` | sha256 hex of the exact request body. The body (the merchant's books) stays off chain. |
| `response` | Base64 of the exact non-streaming `chat.completion` bytes. |
| `signature` | 65-byte `0x` hex ECDSA signature from `GET /v1/signature/{chat_id}?signing_algo=ecdsa`. |

What the contract checks, in order:

1. `sha256(response)` → `response_hash`; signed text = `"{model}:{request_hash}:{response_hash}"`.
2. EIP-191 `personal_sign` digest of that text, `ecrecover`, Ethereum-style address of the key.
3. The address must be registered for exactly this `model` (`SetModelSigner`, M-of-N).
4. `response_hash` was never used before (replay protection; `is_response_used`).
5. The completion's `model` equals `model`; its `created` is at most 1 hour old (5 min skew).
6. `choices[0].message.content` parses as `[{"kind": ProposalKind, "rationale": string}]`,
   1–5 items, only `Payout`, `Allocate` or `Withdraw`, rationale ≤ 500 bytes, each kind passing
   the usual `validate_kind`. Any failure rejects the whole batch.

Each proposal stores `attestation: { model, signer, request_hash, response_hash, created_s }`.
The format was checked against live NEAR AI Cloud responses on 2026-11-10: the signed text is
`model:sha256(request bytes):sha256(response bytes)` and viem's `recoverMessageAddress` returns the
reported `signing_address`.

### Autonomy lane

An attested proposal enters the lane (`auto_execute_after_ms = now + veto_window_ms`) only if:
autonomy is configured and not paused, it is a `Payout` of `policy.token` to an allowlisted
vendor, `amount ≤ max_per_payout`, and today's executed + waiting payouts stay within `daily_cap`
(UTC-day buckets). Its amount is then held against the cap.

- `reject` by any one signer vetoes it and releases the hold.
- `approve` reaching the threshold executes it the normal way and releases the hold.
- `execute_auto(id)` (anyone, ~100 Tgas) after the window re-checks the policy. If it no longer
  fits (vendor removed, cap used, policy changed) the proposal leaves the lane and stays
  `Pending` for signers. Otherwise it reads `ft_balance_of`, requires
  `balance ≥ in-flight outflows + amount + reserve_floor`, and sends `ft_transfer`. Failures mark
  it `Failed` and return the budget.
- `pause()` blocks lane entry and `execute_auto`.

Views: `get_autonomy` (policy, day, spent, committed, remaining), `list_vendors`,
`list_model_signers`, `is_response_used`, `get_outflow_in_flight`.

### Invoices, invoice NFTs and factoring

| Method | Who | Effect |
|---|---|---|
| `submit_invoice(token, amount, due_ms, reference, document_hash)` | anyone, attach 0.01 NEAR | Mints invoice NFT `id` to the caller (issuer = holder). `reference` ≤ 64 bytes; optional 64-hex document hash. |
| `cancel_invoice(invoice_id)` | issuer, while holder | Open → Cancelled (burns the NFT). Not while a payment is pending. |
| `set_invoice_price(invoice_id, price)` | holder | List for sale at `price` in the invoice token, or unlist with `null`. |
| `ft_on_transfer(sender_id, amount, msg)` | the invoice's token | Empty msg: plain deposit. `{"buy_invoice":id}`: buys a listed invoice; NFT → buyer, price − fee → seller, fee → recipient, excess refunded. |
| `claim(token)` | anyone owed | Withdraws a sale payout whose forward failed (`get_claim`). |
| `nft_transfer`, `nft_token`, `nft_tokens`, `nft_tokens_for_owner`, `nft_supply_for_owner`, `nft_total_supply`, `nft_metadata` | NEP-171/177 | Invoices as NFTs (`token_id` = invoice id). Transfer needs 1 yocto and clears a listing. No approvals, no `nft_transfer_call`. |
| `get_invoice`, `list_invoices`, `get_factoring_fee` | views | |

`PayInvoice` resolves the payee at execution: whoever holds the invoice then is paid. In the
autonomy lane the invoice's **issuer** must be allowlisted (`SetVendor`); with `invoices_only`,
raw `Payout`s never enter the lane. A failed payment reopens the invoice. Reject or expire
releases it for a new proposal. Mint, transfer and burn emit NEP-297 `EVENT_JSON` logs.

### Reserve floor under concurrency

`outflow_in_flight` counts stablecoin that passed its balance check but has not settled
(allocations and autonomous payouts). Later checks require `balance ≥ outflow_in_flight + amount
+ reserve_floor`, so two racing allocations can no longer both pass against one snapshot
(`racing_allocations_cannot_both_pass_the_reserve_floor`). Signer-approved payouts are not
counted: signers approve those amounts explicitly.

### Migration

`migrate()` (`#[private]`, `#[init(ignore_state)]`) reads the v1 state, moves proposals from
storage prefix `p` to `q` with the two new fields set to `null`, and keeps signers, policy, caps
and positions. Run it in the same transaction as the deploy so a failure reverts the deploy.

## Verified on testnet

Proposals are numbered from `0`. These are the ones that actually ran end to end; every number
below was read back with a view call.

| # | Kind | Result on chain |
|---|---|---|
| 0 | `SetVenueCap` mock-venue, 500 USDT | `Executed` |
| 1 | `SetPolicy` USDT / 1000 / 100 | `Executed` |
| 2 | `Allocate` 200 USDT → `mock-venue.treasury-dev.testnet` | `Failed`. The venue rejected the deposit (broken `ft_on_transfer` argument). Tokens were refunded in full and no position was booked. |
| 3 | `SetVenueCap` mock-venue2, 500 USDT | `Executed` |
| 4 | `Allocate` 200 USDT → `mock-venue2.treasury-dev.testnet` | `Failed`. No contract code on the account. Full refund, no phantom allocation. |
| 5 | `SetVenueCap` `ghoststore-venue.testnet`, 500 USDT | `Executed` |
| 6 | `Allocate` 200 USDT → `ghoststore-venue.testnet` | `Executed`. Vault position 200 and venue `balance_of(vault)` 200 — the books matched on both sides against the same 400 USDT balance. |
| 7 | `Withdraw` 50 USDT | `Executed`. Venue paid 50; remaining principal 150 (confirmed by #8). |
| 8 | `Withdraw` 500 USDT with only 150 held | `Executed`. The venue paid its full principal (150) and cleared the position; the treasury reduced the position to zero. Vault balance back to 400 USDT. |

Both approvals on every executed proposal came from `treasury-dev.testnet` and
`cosigner.treasury-dev.testnet`.

## Not yet tested on chain

These paths exist in the contract and have unit-test coverage, but have **not** been exercised on
testnet. Do not describe them as proven in a demo:

- Reserve-floor breach: an allocation whose `amount + reserve_floor` exceeds the live balance
  (rollback path with `"reserve floor would be breached"`).
- Venue-cap breach: `amount` pushing cumulative principal over `SetVenueCap`.
- Total-cap breach against `max_total_allocated`.
- Pause behaviour (`pause()`, `SetPaused`, allocations rejected while paused, payouts/withdraws
  still allowed).
- `expire` and approval after the 7-day `PROPOSAL_TTL_MS`.
- Approvals from a signer who was removed between approval and execution.
- Any `Payout`, native or NEP-141, and `reject`.
- `AddSigner` / `RemoveSigner` / `SetThreshold` / `SetProposer` on chain.
- A venue that returns a partial refund from `ft_on_transfer` (`0 < used < amount`).
- A venue whose `withdraw` fails or pays nothing (`on_withdraw_complete` → `Failed`).
- Everything in v2: `migrate`, `propose_attested`, the autonomy lane, `execute_auto`, the new
  governance kinds, `outflow_in_flight`, invoices, invoice NFTs and sales. Unit-tested only
  until the upgrade below is run.

## Yield layer guarantees (enforced on-chain)

1. Only `policy.stable_token` can be allocated.
2. Principal at a venue never exceeds its cap (cumulative, not per proposal).
3. Total principal never exceeds `policy.max_total_allocated`.
4. At execution the treasury checks its live token balance: balance must be at least
   `amount + reserve_floor`, otherwise the allocation is rolled back and marked `Failed`.
5. Any one signer can `pause()`; unpausing needs a proposal. Payouts and withdrawals work while
   paused.
6. Failed transfers and callbacks mark the proposal `Failed` and roll back booked principal.
7. For `Allocate`, the principal is booked **before** the async balance check, so a second
   allocation approved while the first is in flight counts against the caps. The check itself is
   still a snapshot of the balance (see limits).

## Limits (be honest about these in the demo and README)

- `positions` records principal supplied to a venue, not current value. The UI must read live
  value directly from the venue contract (the mock venue pays no yield at all).
- Floors and caps are in token units (absolute amounts), not percentages. The AI can reason about
  percentages, but the contract only enforces the numbers set in `SetPolicy` and `SetVenueCap`.
- The reserve floor covers allocations and autonomous payouts, including concurrent ones (v2,
  `outflow_in_flight`). Signer-approved payouts can still go below it: signers approve those
  amounts explicitly.
- A TEE signature proves which model produced the output, not that the prompt was honest or the
  decision good. Whoever holds the NEAR AI API key and the proposer key chooses the prompt. That
  is why attested proposals get no power beyond the bounded autonomy lane.
- The contract trusts whichever TEE key the signers registered. Checking that key's attestation
  report (Intel TDX quote, key binding) happens off chain in `npm run register-model`; GPU
  attestation and comparing measurements to a published NEAR AI release are not automated.
- The vault account still holds a full-access key (used for deploys and the v2 migration). For
  mainnet, delete it after deploying, or add an upgrade proposal kind, so code changes also need
  M-of-N.
- `Withdraw` has no amount validation against the position; it relies on the venue capping the
  payout at recorded principal. A venue that pays more than asked, or pays without reducing its
  own books, would desynchronise the two ledgers.
- The venue interface (`ft_on_transfer` + `withdraw(token_id, amount)`) is our own design. It was
  built for this hackathon and is implemented by our mock venue. A real venue such as Rhea has a
  different, unchecked interface and would need an adapter and an audit before use.

## Venue interface (what a venue must implement)

**Deposit:** standard NEP-141 `ft_on_transfer(sender_id: AccountId, amount: U128, msg: String)`,
reached by the treasury's `ft_transfer_call` with `msg: ""`. Return the amount *not* used
(`U128(0)` = kept everything). The treasury clamps the result to the requested amount, subtracts
a partial refund from the position, and marks the proposal `Failed` when the venue keeps nothing.

**Withdraw:** `withdraw(token_id: AccountId, amount: U128)`, payable with 1 yoctoNEAR, called by
the treasury. It must send tokens back to the caller and return `U128` of what it actually paid.
Our mock venue returns `U128(payout)` where `payout = min(amount, recorded principal)`, returns
`0` from its own callback if the token transfer failed, and returns `0` straight away — no token
call, no panic — when the caller has no recorded principal at all.

## Gas

Gas shapes from this repo. The `Allocate` row is proven on testnet; the `Withdraw` row is what our
runs used. The other rows are recommendations that have not been exercised on chain.

| Call | Attach |
|---|---|
| `propose`, `reject`, `pause`, `expire` | 30 Tgas |
| `approve` (payouts, governance) | 50 Tgas |
| `approve` (allocate) | 150 Tgas |
| `approve` (withdraw) | 150 Tgas in our runs (the venue call is 40 Tgas, the rest is callbacks) |

An allocation approval chains `ft_balance_of` → `on_allocate_balance` (90 Tgas reserved) →
`ft_transfer_call` → `on_allocate_complete`. Approving with the default 30 Tgas burns the
approval gas before the callback can run, which leaves a proposal `Executed` with no transfer.

## Runbook (the steps that worked)

Prerequisites: `near-cli-rs` 0.30.1, a signing key for the parent account already saved in the
keychain (`near account import-account … save-to-keychain`), and a build:

```sh
cd contracts/treasury      && cargo near build non-reproducible-wasm
cd ../mock-venue           && cargo near build non-reproducible-wasm
# artefacts: contracts/treasury/target/near/treasury.wasm
#            contracts/mock-venue/target/near/mock_venue.wasm
```

> The CLI refuses to sign non-interactively if it has to prompt. Run these in a real terminal;
> a `TTY` error means the key was not found in the keychain, not that the command is wrong.
> Never paste a seed phrase or private key into a shell command or this repo.

### 1. Create and deploy the mock venue

```sh
near account create-account fund-myself ghoststore-venue.testnet '1 NEAR' \
  autogenerate-new-keypair save-to-keychain \
  sign-as treasury-dev.testnet network-config testnet sign-with-keychain send

near contract deploy ghoststore-venue.testnet \
  use-file contracts/mock-venue/target/near/mock_venue.wasm \
  with-init-call new json-args '{}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send
```

`save-to-keychain` on creation is what makes the account redeployable later. Both earlier mock
venues failed this step in one way or another and are unusable.

### 2. Register both accounts on the stable token

Storage registration is required before any `ft_transfer` / `ft_transfer_call`:

```sh
near contract call-function as-transaction usdt.fakes.testnet storage_deposit \
  json-args '{"account_id":"vault.treasury-dev.testnet"}' \
  prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' \
  sign-as treasury-dev.testnet network-config testnet sign-with-keychain send

near contract call-function as-transaction usdt.fakes.testnet storage_deposit \
  json-args '{"account_id":"ghoststore-venue.testnet"}' \
  prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' \
  sign-as treasury-dev.testnet network-config testnet sign-with-keychain send
```

### 3. Deploy the treasury with its init call

```sh
near contract deploy vault.treasury-dev.testnet \
  use-file contracts/treasury/target/near/treasury.wasm \
  with-init-call new \
  json-args '{"signers":["treasury-dev.testnet","cosigner.treasury-dev.testnet"],"threshold":2,"proposer":"ai-proposer.treasury-dev.testnet"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send
```

`new` rejects an empty signer list and a threshold of `0` or above the unique signer count.

### 4. Whitelist the venue and set the policy

Allocations are rejected (`"venue is not whitelisted"`, `"policy not configured"`) until both
exist. Both are ordinary proposals, so each needs two approvals.

```sh
near contract call-function as-transaction vault.treasury-dev.testnet propose \
  json-args '{"kind":{"SetVenueCap":{"venue":"ghoststore-venue.testnet","cap":"500000000"}},"rationale":"Whitelist ghoststore-venue with a 500 USDT cumulative cap"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  sign-as treasury-dev.testnet network-config testnet sign-with-keychain send

near contract call-function as-transaction vault.treasury-dev.testnet approve \
  json-args '{"id":0}' \
  prepaid-gas '50 Tgas' attached-deposit '0 NEAR' \
  sign-as treasury-dev.testnet network-config testnet sign-with-keychain send

near contract call-function as-transaction vault.treasury-dev.testnet approve \
  json-args '{"id":0}' \
  prepaid-gas '50 Tgas' attached-deposit '0 NEAR' \
  sign-as cosigner.treasury-dev.testnet network-config testnet sign-with-keychain send
```

Then the same two-step for `SetPolicy`:

```jsonc
{"kind":{"SetPolicy":{"stable_token":"usdt.fakes.testnet","max_total_allocated":"1000000000","reserve_floor":"100000000"}},"rationale":"USDT stable token, 1000 USDT total cap, 100 USDT reserve floor"}
```

### 5. Propose and approve an allocation

```sh
near contract call-function as-transaction vault.treasury-dev.testnet propose \
  json-args '{"kind":{"Allocate":{"venue":"ghoststore-venue.testnet","token":"usdt.fakes.testnet","amount":"200000000"}},"rationale":"Supply 200 USDT to the whitelisted venue; under the 500 USDT cap and leaves 200 liquid against the 100 USDT floor"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  sign-as treasury-dev.testnet network-config testnet sign-with-keychain send

# 150 Tgas, not 30 — the approval chains ft_balance_of, ft_transfer_call and two callbacks
near contract call-function as-transaction vault.treasury-dev.testnet approve \
  json-args '{"id":6}' \
  prepaid-gas '150 Tgas' attached-deposit '0 NEAR' \
  sign-as treasury-dev.testnet network-config testnet sign-with-keychain send

near contract call-function as-transaction vault.treasury-dev.testnet approve \
  json-args '{"id":6}' \
  prepaid-gas '150 Tgas' attached-deposit '0 NEAR' \
  sign-as cosigner.treasury-dev.testnet network-config testnet sign-with-keychain send
```

The second approval returns the promise; status is `Executed` immediately and may flip to
`Failed` once the callbacks land. Wait a block or two before reading results.

### 6. Verify with view calls

```sh
near contract call-function as-read-only vault.treasury-dev.testnet get_config          json-args '{}' network-config testnet
near contract call-function as-read-only vault.treasury-dev.testnet get_policy          json-args '{}' network-config testnet
near contract call-function as-read-only vault.treasury-dev.testnet get_venue_cap       json-args '{"venue":"ghoststore-venue.testnet"}' network-config testnet
near contract call-function as-read-only vault.treasury-dev.testnet get_positions       json-args '{}' network-config testnet
near contract call-function as-read-only vault.treasury-dev.testnet get_total_allocated json-args '{}' network-config testnet
near contract call-function as-read-only vault.treasury-dev.testnet is_paused           json-args '{}' network-config testnet
near contract call-function as-read-only vault.treasury-dev.testnet get_proposal        json-args '{"id":6}' network-config testnet
near contract call-function as-read-only vault.treasury-dev.testnet list_proposals      json-args '{"from":0,"limit":20}' network-config testnet
near contract call-function as-read-only usdt.fakes.testnet ft_balance_of               json-args '{"account_id":"vault.treasury-dev.testnet"}' network-config testnet
near contract call-function as-read-only ghoststore-venue.testnet list_balances         json-args '{}' network-config testnet
near contract call-function as-read-only ghoststore-venue.testnet balance_of            json-args '{"account_id":"vault.treasury-dev.testnet"}' network-config testnet
```

An allocation is only correct when `get_positions` (treasury side) and `balance_of` on the venue
agree, and `ft_balance_of(vault) + get_total_allocated` equals the minted supply.

## Upgrading testnet to v2

Signs with keys in `~/.near-credentials/testnet`. The v2 code is ~470 KB without `wasm-opt`, so
the treasury account needs ~4.8 NEAR for storage plus margin. The vault's local key no longer
matches its on-chain key, so in-place `upgrade` needs that key (e.g. from the near CLI keychain);
otherwise use `deploy-fresh`, which creates a new treasury and copies the v1 policy.

```sh
# repo root: build (cargo-near is optional; plain cargo works with these flags)
RUSTFLAGS="-C link-arg=-s -C target-cpu=mvp" cargo build \
  --manifest-path contracts/treasury/Cargo.toml --target wasm32-unknown-unknown --release

cd agent
# either: in-place upgrade (needs the vault's key)
node scripts/testnet-v2-setup.mjs fund          # 0.55 NEAR from each signer to the vault
node scripts/testnet-v2-setup.mjs upgrade       # deploy + migrate, one atomic transaction
# or: fresh treasury (treasury-dev.testnet needs ~5.3 NEAR); export the id for every later step
export TREASURY_CONTRACT_ID=vault2.treasury-dev.testnet
node scripts/testnet-v2-setup.mjs deploy-fresh
node scripts/testnet-v2-setup.mjs proposer-key  # FC key: propose, propose_attested, execute_auto
node scripts/testnet-v2-setup.mjs vendors       # create + register the two demo vendors
npm run register-model                          # verify the TEE key; prints its address
node scripts/testnet-v2-setup.mjs governance 0x<address>
                                                # SetModelSigner, SetVendor x2, SetAutonomy
                                                # (invoices only), SetFactoringFee (2-of-2)
node scripts/testnet-v2-setup.mjs invoices      # vendor agents submit 4 invoices (1 bogus)
npm run propose                                 # TEE-signed drafts -> propose_attested
npm run execute-auto                            # after the 5 minute veto window
```

## Attestations (legacy off-chain records)

> Superseded by `propose_attested`, which the contract verifies itself. Kept for proposals
> created before v2.

The treasury contract has **no attestation field** and was not changed for AI proof. It stores
the proposer, the kind, the free-text `rationale` (max 500 UTF-8 bytes) and the created timestamp. The
rationale is immutable after `propose`.

The AI agent may append an off-chain commitment tag to the rationale:

```text
<AI rationale> [att:<12 lowercase hex>]
tag = SHA-256(canonical JSON of { kind, rationaleBase })[0:12]
```

`rationaleBase` is the AI text before the tag. The tag is computed before submission because the
contract assigns `proposalId` inside `propose`. The off-chain record then signs
`contentHash = SHA-256(canonical JSON of { proposalId, kind, full rationale })`, which binds the
actual id, the full rationale and the tag. The web route
`GET /api/attestation/[proposalId]` re-reads `get_proposal`, recomputes the tag and content hash,
and verifies the ed25519 signature. Any change to the amount, kind, recipient, rationale or tag
after signing is a mismatch.

What the chain guarantees and what it does not:

- **Guaranteed by the contract:** the stored `rationale`, `kind` and `proposer` do not change
  after `propose`; the rationale length is bounded; the proposer account is recorded.
- **Not guaranteed by the contract:** that the rationale came from a TEE, that an off-chain record
  exists, or that a signature is valid. Those are off-chain checks.
- **Not stored:** transaction hashes and attestation records. The UI links accounts to NEAR Blocks,
  not a specific transaction, and the record service is the source for proof JSON.
- **Planned, not implemented:** hardware TEE report verification. A signed record without a
  verified report is reported as `partial` / “Partially verified”, never `verified`. See
  [`ATTESTATION.md`](ATTESTATION.md).

To inspect the commitment for an existing proposal:

```sh
near contract call-function as-read-only vault.treasury-dev.testnet get_proposal \
  json-args '{"id":6}' network-config testnet
```

The returned `rationale` ends with `[att:...]` only for proposals submitted by an agent that had a
signing key. Existing proposals #0–#8 were submitted before this convention and have no tag, so
they correctly show no AI proof.

## Lessons and gotchas

- **Venue accounts need a saved signing key before deploy.** Each `mock-venue*` account was
  created without a key we kept; one account has no usable key at all and the other ended up with
  no code. Create subaccounts with `autogenerate-new-keypair save-to-keychain` and check
  `near account view-account-summary` shows a real `code_hash` (not `1111…`) after deploying.
- **Wasm costs storage.** The mock venue is ~100 KB and locks roughly 1 NEAR in storage staking;
  the treasury is ~217 KB and locks about 2.2 NEAR. Fund a new contract account with more than
  1 NEAR or the deploy fails on storage.
- **`ft_on_transfer` must name its third argument `msg`.** near-sdk derives JSON field names from
  the Rust parameter names, and NEP-141 tokens always send `{"sender_id","amount","msg"}`. An
  earlier `_msg` argument made every deposit panic with `missing field _msg`, which is why
  proposals #2 and #4 failed and refunded.
- **Use 150 Tgas on `approve` for allocations** (and for withdrawals in our runs). The default
  gas is consumed before the chained callbacks can run.
- **`Executed` is optimistic.** `approve` sets it before the async callbacks finish; an
  allocation or withdraw callback can later set the same proposal to `Failed` and roll the
  position back. Read the status after the callbacks, not from the approve receipt.
- **Deploy the right wasm path.** Builds land in `contracts/<crate>/target/near/*.wasm`;
  deploying `target/near/…` from the repo root quietly points at nothing.
- **`AddSigner` etc. are proposals, not calls.** `pause()` is the only instant governance action.
- **The AI proposer cannot approve.** Use a signer key for every `approve`, or the call panics
  with `"only a signer can do this"`.
- **State layout is not migratable.** Deploying new code over an account whose stored state has a
  different shape makes every call fail to deserialize. The fix is a fresh account (or a
  migration function, which does not exist yet) — do not delete and recreate the funded vault as
  a routine step.
