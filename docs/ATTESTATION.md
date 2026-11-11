# AI proposal attestations

How a proposal proves it was written by a specific model running in NEAR AI Cloud's TEE, and
who checks that. Short version: **the treasury contract checks it, on chain, for every AI
proposal.** The merchant's books never leave the TEE and never go on chain.

## The flow

```
agent (Node)                         NEAR AI Cloud (Intel TDX + GPU TEE)          treasury contract
------------                         -----------------------------------          -----------------
books.json + on-chain state
  -> request body ---------------->  Qwen3.6 runs inside the TEE
  <- response bytes  <-------------  returns the completion
  -> GET /v1/signature/{chat_id} ->  TEE key signs
  <- signature  <------------------    "{model}:{sha256(request)}:{sha256(response)}"
propose_attested(model, request_hash, response, signature) ---------------------> sha256(response)
                                                                                   ecrecover(EIP-191)
                                                                                   key registered?
                                                                                   not replayed? fresh?
                                                                                   parse proposals from
                                                                                   the signed output
```

1. `agent/src/propose.ts` reads the treasury state from chain and the private books from
   `agent/data/books.json` (falls back to `books.example.json`).
2. It sends one non-streaming completion to a model NEAR AI runs inside its own TEE
   (`owned_by: "nearai"`; default `Qwen/Qwen3.6-35B-A3B-FP8`). A JSON schema constrains the
   output to the contract's draft format: `PayInvoice` may only name open on-chain invoices,
   payees are limited to the books' vendor accounts, and venues to whitelisted ones. Before
   inference the agent reconciles bills with invoices (issuer, reference, token and exact amount)
   and with pending proposals; the schema then admits only matched, unpaid invoices and raw payouts
   for bills with no invoice and nothing in flight. An early version left matching to the model,
   which once proposed a raw payout for a bill that had a matching invoice (a double-pay risk).
   If the model returns an empty list while a reconciled bill is owed and due within 14 days, the
   agent asks again (up to `MAX_ATTEMPTS`, default 3). Each attempt is a separate signed
   completion, and only one is ever submitted, unaltered.
3. It fetches the ECDSA response signature and checks locally that the signed text is
   `model:sha256(request bytes):sha256(response bytes)`.
4. It calls `propose_attested` with the exact response bytes, the request hash and the signature.
   The contract recomputes the hash, recovers the signer, requires a governance-registered key
   for that model, rejects reused or stale responses, and creates the proposals **from the signed
   model output**. The agent cannot change an amount, recipient or rationale after inference.

Details of every contract check: [`CONTRACT.md` → v2](CONTRACT.md#v2-attested-ai-proposals-and-the-autonomy-lane).

## Registering a model key (once, by governance)

`npm run register-model` (in `agent/`), implemented in `agent/src/tee-verify.ts`:

| Check | How | Result on 2026-11-10 (Qwen3.6) |
|---|---|---|
| Report bound to a fresh nonce | `request_nonce` echoes our random 32 bytes | pass |
| Intel TDX quote is genuine | `@phala/dcap-qvl` with Intel collateral (Phala PCCS) | pass, TCB `UpToDate`, no advisories |
| TD not in debug mode | TDATTRIBUTES bit 0 | pass |
| Quote binds the signing key | REPORTDATA = `signing_address ‖ 12 zero bytes ‖ nonce` | pass |
| NVIDIA GPU attestation | — | not checked |
| Measurements match a published NEAR AI release | prints MRTD, RTMR0-3, MRCONFIGID | not checked (manual comparison) |

With `-- --propose` it submits `SetModelSigner { address, model }`. The contract trusts the key
only after M-of-N signers approve. The signing address was the same across every request we
made (`0xfdbd7952498b333206f360d71d97a1e0961e8ddf`), so this is a one-time step per model
deployment; if NEAR AI rotates the key, attested proposals fail until signers register the new one.

## What it proves, and what it does not

Proves:
- The proposal text and amounts are exactly what a TEE-held key for that model signed.
- That key was in a genuine, non-debug Intel TDX VM when signers registered it.
- The private request had a specific hash. Anyone holding the books can recompute it.

Does not prove:
- That the prompt was honest. Whoever holds the NEAR AI API key and the proposer key writes the
  prompt and could ask for a bad payout. The signature proves **origin**, not **judgment**.
  That is why an attested proposal gets no extra power except the bounded autonomy lane
  (allowlisted vendors, per-payout and daily caps, a veto window, the reserve floor), and
  everything else still needs M-of-N.
- That the GPU and the exact NEAR AI software release were verified (not automated here).
- Anything about the agent process itself. It does not run in a TEE; it only relays bytes it
  cannot alter without breaking the signature.

## Evidence in this repo

- `contracts/treasury/src/real_vectors.rs`: a real NEAR AI Cloud completion and TEE signature
  captured on 2026-11-10. The unit test `real_near_ai_tee_signature_is_verified_on_chain` runs
  `propose_attested` on it (same `ecrecover` host function as on chain).
- `contracts/treasury/src/test_vectors.rs`: fixtures signed with a public test key
  (`scripts/gen-test-vectors.mjs`) for tampering, replay, staleness and policy tests.

## Legacy: off-chain attestation records

Before v2, the agent signed an off-chain record with an agent-held ed25519 key and put an
`[att:<12 hex>]` tag in the rationale; the web route `GET /api/attestation/[proposalId]`
verified it and showed **Partially verified** at best. That path (`agent/src/attestation*.ts`,
`web/lib/attestation*.ts`) remains for proposals created before v2. The UI shows the on-chain
proof whenever a proposal has `attestation` set.
