# NEAR Private Treasury (working title)

An AI treasurer for merchants. The AI reads the merchant's books privately inside a TEE, and the
**contract** decides what it may do. Built at NEAR HACKATHON (Nov 1–14, 2026).

> **Status (2026-11-11).** v2 is deployed on NEAR testnet at `vault2.treasury-dev.testnet`:
> AI proposals whose NEAR AI TEE signature is verified by the contract, a bounded autonomy lane,
> agent-to-agent invoices and invoice NFTs with a factoring fee. Two invoices were paid by the
> autonomy lane with no signer approval (see [What is proven on testnet](#what-is-proven-on-testnet-v2)).
> 101 contract unit tests, one using a real NEAR AI Cloud TEE signature. The checkout settled a real
> mainnet payment through NEAR Intents on 2026-11-12 (see
> [Proven on mainnet](#proven-on-mainnet-checkout-via-near-intents)). Anything planned is labelled "planned".

## What's different

Most AI-treasury projects pair an AI that drafts proposals with a multisig, and show a
"verified" badge in the UI. Here the trust checks run in the contract:

1. **The contract checks the AI's TEE signature.** NEAR AI Cloud signs every completion with a
   key held inside an Intel TDX confidential VM. `propose_attested` recomputes the response
   hash, recovers the signer with `ecrecover`, requires a key that signers registered after
   checking its hardware attestation, and **parses the proposals out of the signed model output**.
   The agent cannot alter an amount or recipient after inference. Only the hash of the private
   request goes on chain; the books stay private.
2. **Bounded autonomy, enforced on chain.** An attested payout to an allowlisted vendor, within a
   per-payout limit and a daily cap, executes after a veto window **without approvals**. One
   signer can veto it. Everything else (new payees, larger amounts, yield allocations,
   governance) still needs M-of-N. The reserve floor is checked against the live balance, and
   in-flight outflows are counted so concurrent payouts can't both pass the check.

3. **Agent-to-agent invoices.** Vendors, or their agents, submit invoices on chain. The agent
   reconciles them with the private books (issuer, reference and exact amount must match) and
   the model's output schema only admits matched invoice ids, plus raw payouts for bills that have
   no invoice and no payment in flight. The model proposes `PayInvoice { invoice_id }`: it names an
   invoice, never a payee, and with `invoices_only` raw payouts can't use the autonomy lane at all.
   Fake invoices can't be named and bills can't be paid twice.
4. **Invoices are NFTs you can sell.** Each invoice is an NEP-171 token and the treasury pays
   whoever holds it. A vendor can list an unpaid invoice and a buyer pays atomically with
   `ft_transfer_call`, minus a governance-set fee: on-chain invoice factoring.

A TEE signature proves which model wrote a proposal, not that it is a good idea. So it only buys
the AI a small, capped amount of autonomy. That design is the main idea of the project.

### For agent builders

The same contract is a wallet any agent can be trusted with: decisions verified on chain,
per-payout and daily caps, an allowlist, invoice-backed payments, a veto window and a one-signer
pause. Agents that pay for APIs, compute or suppliers get spending power without a blank cheque.

### How it earns

| Stream | Status |
|---|---|
| Fee on invoice sales (`SetFactoringFee`, up to 10%) | Implemented in the contract |
| Fee on checkout payments settled through NEAR Intents | Planned |
| Hosted treasuries for agent builders (policy templates, keeper, monitoring) | Planned |

## Hackathon tracks

Autonomous Business · AI Security & Defense · Privacy & Private AI · Real-World Money ·
Agent Economy · NFTs That Do Something

## Demo flow (after the v2 upgrade)

1. `agent/data/books.example.json` holds sales, customer names and three bills: two from
   recurring vendors (40 and 25 USDT) and one from a new supplier (120 USDT). The vendors'
   agents submit matching invoices on chain, plus one invoice (FM-0099, 45 USDT) that matches
   no bill.
2. `npm run propose`: Qwen3.6 drafts payouts inside NEAR AI's TEE. In a dry run on 2026-11-10
   it proposed one payout per bill, in base units, with no customer data in the rationales, and
   no yield allocation (cash after payouts was below the payroll buffer). The TEE signature
   matched the hash of the returned bytes.
3. The AI proposes `PayInvoice` for the three matching invoices and skips FM-0099. The contract
   verifies the signature and puts the two allowlisted vendors' invoices in the autonomy lane
   (65 of the 100 USDT daily cap). The treasury page shows a countdown and a **Veto** button.
   The new supplier is not allowlisted, so its invoice waits for 2-of-2 approval.
   Meanwhile the vendor can sell an invoice on `/invoices`; the buyer then receives the payment.
4. After the 5-minute window, `npm run execute-auto` (or **Execute payout** in the UI; anyone can
   call it) pays the vendors. Pause, a vendor removal or a breached reserve floor stops it.

## Proven on mainnet: checkout via NEAR Intents

On 2026-11-12 a customer paid the demo order from MetaMask with USDC on BNB Chain. NEAR Intents
(1Click API) swapped it and credited the merchant, `diamonaz.near`, with USDC on NEAR inside the
Intents ledger (`intents.near`, `recipientType: INTENTS`), so the merchant account needed no NEAR
and no token storage deposit.

| Step | Value |
|---|---|
| Customer paid | 1.2 USDC on BNB Chain, from `0x5Ce7a697d2710275e14179E8D62C816628737A6b` |
| Deposit tx (BNB Chain) | [`0x8444c228…a23cfbf8`](https://bscscan.com/tx/0x8444c228ef0bf906931857cc949cfbda090bc612fc930cbcdee5bf70a23cfbf8) to deposit address `0x146a3d10a89163b2ee0006b1de2af49ea2d02609` |
| Merchant received | 1.199876 USDC (`nep141:17208628…6133a1`) for `diamonaz.near` in `intents.near` |
| Settlement tx (NEAR) | [`CxmAGV15…DPWsdc`](https://nearblocks.io/txns/CxmAGV15vzuia7ZRMwupLHUXGVrYg3qXbNyzMiDPWsdc) |
| 1Click status | `SUCCESS`, about 30 s from deposit to credit; gas paid by the customer: about 0.000003 BNB |

Check it yourself: `GET https://1click.chaindefuser.com/v0/status?depositAddress=0x146a3d10a89163b2ee0006b1de2af49ea2d02609`,
or call `mt_balance_of` on `intents.near` for `diamonaz.near`.

Not yet connected: the funds land in the merchant's Intents balance, not in the testnet treasury
contract. Moving settled checkout revenue into a mainnet treasury is the next step.

## What is proven on testnet (v2)

Treasury `vault2.treasury-dev.testnet`, 2-of-2 signers as below. Configured by governance
proposals: registered TEE key `0xfdbd…8ddf` for `Qwen/Qwen3.6-35B-A3B-FP8`, vendor allowlist
(`packaging.treasury-dev.testnet`, `courier.treasury-dev.testnet`), autonomy lane (50 USDT per
payout, 100 USDT per UTC day, 5-minute veto window, invoices only), 0.5% factoring fee.

| Scenario | Proposal / invoice | Outcome |
|---|---|---|
| Vendor agents submit invoices | invoices #0 PKG-2291 (40), #1 CR-7781 (25), #2 FM-0042 (120) | `Open`, minted as NEP-171 tokens |
| `propose_attested` from a live Qwen3.6 completion | #7, #8 `PayInvoice` | Contract verified the TEE signature and put both in the autonomy lane |
| Keeper calls `execute_auto` after the veto window | #7, #8 | `Executed` with **zero approvals**; vendors hold 40 and 25 USDT, invoices `Paid` |
| An early agent proposed a raw payout for a bill that had an invoice | #9 `Payout` 120 to fabric-mill | Not allowlisted, so no autonomy; signers `Rejected` it. The agent now reconciles bills and invoices deterministically before inference |
| New supplier's invoice, not allowlisted | #10 `PayInvoice` for #2 FM-0042 (120) | AI proposed it from a fresh TEE-signed completion; `Executed` after **2-of-2** approval; invoice `Paid` |
| Invoice that matches no bill | #3 FM-0099 (45) | `Open`; never proposed |

Vault balance after: 215 USDT (400 − 40 − 25 − 120).

## What is proven on testnet (v1)

| Role | Account |
|---|---|
| Treasury contract | `vault.treasury-dev.testnet` |
| Mock venue | `ghoststore-venue.testnet` |
| Stable token (6 decimals) | `usdt.fakes.testnet` |
| Signers (2-of-2) | `treasury-dev.testnet`, `cosigner.treasury-dev.testnet` |
| AI proposer (function-call key) | `ai-proposer.treasury-dev.testnet` |

| Scenario | Proposal | Outcome |
|---|---|---|
| Allocate 200 USDT to the venue | #6 | `Executed`; treasury position and venue principal both read 200 |
| Withdraw 50 USDT | #7 | `Executed`; venue paid 50, principal left at 150 |
| Withdraw 500 USDT while only 150 was held | #8 | `Executed`; venue paid its full 150 and cleared the position |
| Allocate to a broken venue | #2, #4 | `Failed`; tokens refunded in full, no phantom allocation |

Policy on chain: 1000 USDT total allocation cap, 100 USDT reserve floor, 500 USDT cap on the
venue. Vault balance 400 USDT. Details and the untested-paths list: [`docs/CONTRACT.md`](docs/CONTRACT.md).

## What is verified off chain

- Live NEAR AI Cloud (2026-11-10): the response signature format, that the TEE signing key is
  stable across requests, and the model's Intel TDX quote (`UpToDate`, not debug, REPORTDATA
  binds the signing key and our nonce). `npm run register-model` reproduces this.
  NVIDIA GPU attestation and comparing measurements to a NEAR AI release are **not** automated.
- The contract accepts that real signature in a unit test (`real_near_ai_tee_signature_is_verified_on_chain`),
  and rejects tampered amounts, request hashes, model names, replays, stale responses and
  governance kinds.

## Architecture

```
customer -> checkout (web) -> NEAR Intents quote/settle (mainnet, proven) -> merchant (treasury link planned)
                                                                        ^      ^
agent: books + chain state -> NEAR AI TEE model -> signed output ------+      |
       (propose_attested; contract verifies the TEE signature)                |
signers (web): approve / reject / veto / pause -------------------------------+
anyone: execute_auto after the veto window
```

- `contracts/treasury`: Rust, near-sdk 5. M-of-N approvals, propose-only AI role, on-chain TEE
  signature verification, autonomy lane, invoices as NEP-171 NFTs with atomic sales, stablecoin
  yield layer (venue caps, total cap, reserve floor, pause), v1→v2 `migrate`. 101 unit tests.
- `contracts/mock-venue`: venue stub (`ft_on_transfer` + `withdraw`); records principal, earns no yield.
- `agent`: `propose` (books → TEE model → `propose_attested`), `register-model` (TDX quote check,
  `SetModelSigner` proposal), `execute-auto` (permissionless keeper), `scripts/testnet-v2-setup.mjs`.
- `web`: Next.js app: treasury (on-chain proof, autonomy budget, veto/execute, "Needs you"),
  invoices (submit, sell, buy, propose payment), dashboard, checkout and flows. Read-only without
  a wallet; actions are signed with a NEAR wallet.
- Docs: [`CONTRACT.md`](docs/CONTRACT.md), [`ATTESTATION.md`](docs/ATTESTATION.md), [`PLAN.md`](docs/PLAN.md).

## Limits (honest about what this does not do)

- The checkout depends on NEAR Intents, which is mainnet-only; the treasury is on testnet. One
  real payment has settled on mainnet (above), into the merchant's Intents balance; it is not
  yet routed into a treasury contract.
- A TEE signature proves origin, not intent: the holder of the API and proposer keys writes the
  prompt. The autonomy lane's caps, allowlist, veto window and reserve floor are what bound the damage.
- The agent process itself does not run in a TEE; it relays bytes it cannot alter undetected.
- Payouts are public on chain: amounts and vendor accounts are visible. What stays private are
  the AI's inputs (sales, customers, bills).
- `positions` records principal, not value; the mock venue pays no yield. The venue interface
  is our own; a real venue (e.g. Rhea) would need an adapter and an audit.
- Signer-approved payouts can go below the reserve floor (signers approve those amounts explicitly).
- The vault still has a full-access key (used for deploys). For mainnet it should be removed
  or replaced with an upgrade proposal kind.
- Invoice NFTs implement NEP-171 core and NEP-177 metadata, without approvals (NEP-178) or
  `nft_transfer_call`, so external marketplaces can't list them yet; sales use the built-in market.
- Buying an invoice is a bet that the merchant pays it. Nothing on chain guarantees payment.

## Run locally

```sh
cp .env.example .env                         # agent values; never commit
cp web/.env.local.example web/.env.local     # web values
(cd contracts/treasury && cargo test)        # 101 tests
(cd web && npm install && npm test && npm run dev)
(cd agent && npm install && npm run register-model && DRY_RUN=true npm run propose)
```

`DRY_RUN=true` runs the private inference, signature fetch and local checks without
submitting. Deploying v2 and configuring autonomy: [`docs/CONTRACT.md`](docs/CONTRACT.md#upgrading-testnet-to-v2).

## Hackathon disclosure

- All code in this repo was written during the hackathon window unless listed here.
- AI-assisted code: parts of this repo were written with Claude Code. Libraries are listed in
  each `package.json` / `Cargo.toml`.

## License

MIT, see LICENSE.
