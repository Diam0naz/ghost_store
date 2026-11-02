# NEAR Private Treasury (working title)

A private AI treasury for merchants, built at NEAR HACKATHON (Nov 1-14, 2026).

> Status: scaffold. Sections marked TODO are filled in as features land.

## What it is

Customers pay a merchant in any token. The payment settles to the merchant treasury as a stablecoin via NEAR Intents. A confidential AI assistant (NEAR AI Cloud, TEE) reads the merchant's sensitive financial data and drafts proposals: vendor payouts and one yield allocation. Signers approve in an M-of-N treasury contract. The AI can propose but cannot approve or hold keys.

## Problem

Merchants accepting crypto hold balances across chains, must pay vendors, and have idle funds. Doing this safely today means exposing financial data to third parties or letting one key control everything.

## Hackathon tracks

`privacy`, `realworld`, `security`, `defi`

## How to try it (do X, see Y)

TODO: fill in once the demo works. Planned:

1. Open the checkout link, pay with a non-stablecoin token. See a quote and a settlement into the treasury.
2. Open the treasury dashboard. See the AI's proposals (payout batch, yield allocation) with its TEE attestation.
3. Approve as signer 1 and signer 2. See the proposal execute.

## Architecture

```
customer -> checkout (web) -> NEAR Intents quote/settle -> treasury contract
                                                              ^
AI proposer (agent/, NEAR AI Cloud TEE) --propose only--------+
signers (web) --approve/reject-------------------------------+
```

- `contracts/treasury`: Rust (near-sdk). M-of-N approvals, restricted proposer role, venue whitelist and per-venue caps.
- `web`: Next.js checkout, treasury dashboard and flow view.
- `agent`: proposer service that calls NEAR AI Cloud and submits proposals.
- `docs/PLAN.md`: two-week plan.

## What the TEE protects (and what it does not)

TODO: be exact. Draft: inference inputs (sales, bills, balances) stay confidential during AI processing. Onchain payouts, proposals and balances are public on NEAR.

## NEAR integrations

- NEAR Intents for cross-chain checkout and settlement (mainnet only, no testnet exists)
- NEAR AI Cloud (private inference)
- Rust smart contract on NEAR

## Hackathon disclosure

- All code in this repo was written during the hackathon window unless listed here.
- Libraries and AI-assisted code: TODO list in README before submitting (rule Q-005).
- Intents testing uses tiny mainnet amounts and `dry: true` quotes (rule Q-007).

## Run locally

```sh
cp .env.example .env     # fill in keys locally, never commit them
cd contracts/treasury && cargo test
cd ../../web && npm install && npm run dev
cd ../agent && npm install && npm run propose
```

## License

MIT, see LICENSE.
