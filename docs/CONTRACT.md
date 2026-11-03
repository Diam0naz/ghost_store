# Treasury contract reference

Contract: `contracts/treasury`. Rust, near-sdk 5. 39 unit tests (`cargo test`).

## Roles

| Role | Can | Cannot |
|---|---|---|
| `proposer` (AI service) | `propose` | approve, reject, pause, execute anything |
| `signers` (humans) | `propose`, `approve`, `reject`, `pause` | |
| anyone | views, `expire` (stale proposals) | |

Execution needs `threshold` approvals from accounts that are still signers when the threshold is reached.

## Proposal kinds

| Kind | Effect |
|---|---|
| `Payout { to, token, amount }` | Pay NEAR (`token: null`) or an NEP-141 token. Native payouts keep storage staking + 0.5 NEAR free. |
| `Allocate { venue, token, amount }` | Supply stablecoin to a whitelisted venue. |
| `Withdraw { venue, amount }` | Pull funds back by calling the venue's `withdraw`. |
| `SetVenueCap { venue, cap }` | Whitelist a venue with a cumulative principal cap (`0` removes it). |
| `SetPolicy { stable_token, max_total_allocated, reserve_floor }` | Configure the yield layer. |
| `SetPaused { paused }` | Pause or unpause allocations. |
| `AddSigner`, `RemoveSigner`, `SetThreshold`, `SetProposer` | Governance. |

## Yield layer guarantees (enforced on-chain)

1. Only `policy.stable_token` can be allocated.
2. Principal at a venue never exceeds its cap (cumulative, not per proposal).
3. Total principal never exceeds `policy.max_total_allocated`.
4. At execution the treasury checks its live token balance: balance must be at least `amount + reserve_floor`, otherwise the allocation is rolled back and marked `Failed`.
5. Any one signer can `pause()`; unpausing needs a proposal. Payouts and withdrawals work while paused.
6. Failed transfers and callbacks mark the proposal `Failed` and roll back booked principal.

## Limits (be honest about these in the demo and README)

- `positions` records principal supplied to a venue, not current value. The UI must read live value directly from the venue contract.
- Floors and caps are in token units (absolute amounts), not percentages. The AI can reason about percentages, but the contract only enforces the numbers set in `SetPolicy` and `SetVenueCap`.
- Two allocations approved within seconds of each other can both pass the reserve-floor balance check, because each reads the same on-chain balance before either transfer settles.
- The venue withdraw interface (`withdraw(token_id, amount)`) is our own design. Rhea's real interface is unchecked and would need an adapter. A mock venue is the next piece.

## Venue interface (what a venue must implement)

Deposit: standard NEP-141 `ft_on_transfer(sender_id, amount, msg)`, receiving tokens via the treasury's `ft_transfer_call`.

Withdraw: `withdraw(token_id: AccountId, amount: U128)`, payable with 1 yoctoNEAR, which sends tokens back to the caller.

A mock venue implementing this is the plan for testnet. Real venues (for example Rhea) need an adapter and must be checked against their docs. Not verified.

## Gas

| Call | Attach |
|---|---|
| `propose`, `reject`, `pause` | 30 Tgas |
| `approve` (payouts, governance) | 50 Tgas |
| `approve` (allocate) | 150 Tgas |

## Redeploy after state layout change

The state layout changed (yield layer fields added). Delete and recreate the vault account before deploying.

```sh
# 1. Delete the old account (funds go back to the parent)
near account delete-account vault.treasury-dev.testnet beneficiary treasury-dev.testnet network-config testnet sign-with-keychain send

# 2. Recreate it
near account create-account fund-myself vault.treasury-dev.testnet '1 NEAR' autogenerate-new-keypair save-to-keychain sign-as treasury-dev.testnet network-config testnet sign-with-keychain send

# 3. Build
cd contracts/treasury && cargo near build --release

# 4. Deploy and initialise
near contract deploy vault.treasury-dev.testnet \
  use-file target/near/treasury.wasm \
  with-init-call new json-args '{"signers":["signer1.testnet","signer2.testnet"],"threshold":2,"proposer":"ai-proposer.testnet"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send
```

## First-time setup after deploy

After deploying, governance proposals are needed before the AI can allocate.

1. **`SetVenueCap`** — propose and approve one per venue (cap is in `stable_token` units).
2. **`SetPolicy`** — propose and approve once (sets stable token, total cap, reserve floor).
3. The AI can now propose `Allocate` and `Withdraw`.

Use **150 Tgas** when calling `approve` on `Allocate` proposals. The allocation path chains a balance check (`ft_balance_of`), `ft_transfer_call`, and two callbacks. Payouts and governance approvals need only 50 Tgas.
