// AI proposer. Reads treasury data, calls NEAR AI Cloud (private inference in TEE)
// for proposals, and submits each one to the treasury contract via `propose`.
//
// The proposer account MUST have a function-call access key limited to `propose`
// on the treasury contract. It can never approve or execute.

import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env from the repo root (one level up from agent/)
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

import { connect, keyStores, KeyPair, utils } from "near-api-js";

// ---- types -----------------------------------------------------------------

type ProposalKind =
  | { Payout: { to: string; token: string | null; amount: string } }
  | { Allocate: { venue: string; token: string; amount: string } }
  | { Withdraw: { venue: string; amount: string } };

interface Draft {
  kind: ProposalKind;
  rationale: string;
}

interface Policy {
  stable_token: string;
  max_total_allocated: string;
  reserve_floor: string;
}

interface TreasuryContext {
  stable_token: string;
  /** Total principal currently deployed across all venues (in token units). */
  total_allocated: string;
  /** Per-venue principal [venue_id, amount] */
  positions: [string, string][];
  /** Remaining room before the total cap is hit. */
  allocation_headroom: string;
  /** Venue caps [venue_id, cap] */
  venue_caps: { venue: string; cap: string }[];
}

// ---- helpers ---------------------------------------------------------------

const getEnv = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var ${k}`);
  return v;
};

function isValidKind(kind: unknown): kind is ProposalKind {
  if (typeof kind !== "object" || kind === null) return false;
  return "Payout" in kind || "Allocate" in kind || "Withdraw" in kind;
}

// ---- NEAR connection -------------------------------------------------------

// Module-level cache: connect() is expensive (HTTP handshake + key derivation).
// We create the account object once and reuse it for both context reads and submit.
import type { Account } from "near-api-js";
let _accountCache: Account | null = null;

async function nearAccount(): Promise<Account> {
  if (_accountCache) return _accountCache;

  const network = process.env.NEAR_NETWORK ?? "testnet";
  const nodeUrl =
    process.env.NEAR_RPC_URL ??
    (network === "mainnet"
      ? "https://rpc.mainnet.near.org"
      : "https://rpc.testnet.near.org");

  const proposerAccountId = getEnv("PROPOSER_ACCOUNT_ID");
  const privateKey = getEnv("PROPOSER_PRIVATE_KEY");

  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(
    network,
    proposerAccountId,
    KeyPair.fromString(privateKey as `ed25519:${string}`)
  );

  const near = await connect({ networkId: network, keyStore, nodeUrl });
  _accountCache = await near.account(proposerAccountId);
  return _accountCache;
}

// ---- on-chain treasury context ---------------------------------------------

/**
 * Reads live treasury state from the contract and returns a structured context
 * object safe to include in the AI prompt. No secrets are included; everything
 * here is already public on-chain.
 */
async function fetchTreasuryContext(): Promise<TreasuryContext> {
  const contractId = getEnv("TREASURY_CONTRACT_ID");
  const account = await nearAccount();

  // Fire all three reads in parallel.
  const [policyRaw, totalAllocatedRaw, positionsRaw] = await Promise.all([
    account.viewFunction({ contractId, methodName: "get_policy", args: {} }),
    account.viewFunction({ contractId, methodName: "get_total_allocated", args: {} }),
    account.viewFunction({ contractId, methodName: "get_positions", args: {} }),
  ]);

  const policy = policyRaw as Policy | null;
  const totalAllocated: string = totalAllocatedRaw as string ?? "0";
  const positions = positionsRaw as [string, string][];

  if (!policy) {
    throw new Error("Treasury policy not set — run SetPolicy governance proposal first.");
  }

  // Compute allocation headroom: max_total_allocated - total_allocated
  const headroom =
    BigInt(policy.max_total_allocated) - BigInt(totalAllocated);

  // Build per-venue cap list. We can't enumerate all caps from a single view call
  // (no list_venue_caps method), but we can read caps for venues that already have
  // a position, which is the most relevant set for the AI.
  const knownVenues = positions.map(([v]) => v);
  const venueCaps: { venue: string; cap: string }[] = [];
  for (const venue of knownVenues) {
    const cap = await account.viewFunction({
      contractId,
      methodName: "get_venue_cap",
      args: { venue },
    }) as string | null;
    if (cap) venueCaps.push({ venue, cap });
  }

  return {
    stable_token: policy.stable_token,
    total_allocated: totalAllocated,
    positions,
    allocation_headroom: headroom >= 0n ? headroom.toString() : "0",
    venue_caps: venueCaps,
  };
}

// ---- NEAR AI Cloud --------------------------------------------------------

async function draftProposals(ctx: TreasuryContext): Promise<Draft[]> {
  const baseUrl = getEnv("NEAR_AI_BASE_URL");
  const apiKey = getEnv("NEAR_AI_API_KEY");
  const model = getEnv("NEAR_AI_MODEL");

  // The context passed here is fully public on-chain data. Sensitive merchant
  // data (sales figures, vendor identities) must be injected separately inside
  // the TEE and must NOT appear in the rationale field, which is stored on-chain
  // in plaintext.
  const userPayload = {
    treasury: ctx,
    note: "Propose at most one Allocate and one Payout per run. " +
          "Use only the stable_token for Allocate/Withdraw. " +
          "Withdraw is available if a position exists at a venue. " +
          "All amounts are in the token's smallest unit (6 decimals for USDT).",
  };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a treasury AI. Draft proposals as a JSON array of {kind, rationale}. " +
            "Allowed kinds:\n" +
            "  {Payout:{to,token,amount}}  — token is null for native NEAR, else an AccountId\n" +
            "  {Allocate:{venue,token,amount}}  — token must equal treasury.stable_token\n" +
            "  {Withdraw:{venue,amount}}  — only if a position exists at that venue\n" +
            "amount is always a string (integer in smallest token units). " +
            "rationale must be ≤500 chars and must NOT include sensitive financial figures or PII. " +
            "Output valid JSON only. No markdown fences, no prose.",
        },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`NEAR AI request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };

  const raw = data.choices[0].message.content.trim();

  let drafts: Draft[];
  try {
    drafts = JSON.parse(raw) as Draft[];
  } catch {
    throw new Error(`AI returned non-JSON: ${raw}`);
  }

  if (!Array.isArray(drafts)) {
    throw new Error(`AI returned non-array: ${raw}`);
  }

  return drafts;
}

// ---- submit ---------------------------------------------------------------

async function submit(drafts: Draft[]): Promise<void> {
  const contractId = getEnv("TREASURY_CONTRACT_ID");
  const account = await nearAccount();

  for (const d of drafts) {
    // ---- client-side validation -------------------------------------------

    // Rationale: required, ≤500 chars, on-chain in plaintext
    if (!d.rationale || d.rationale.length > 500) {
      console.warn("Skipping draft with invalid rationale:", d);
      continue;
    }

    // Kind: must be one of the three recognised variants
    // (fixed: was `!"Payout" in d.kind` which parsed as `(!"Payout") in d.kind`)
    if (!isValidKind(d.kind)) {
      console.warn("Skipping draft with unknown kind:", d);
      continue;
    }

    console.log("Proposing:", JSON.stringify(d));

    const outcome = await account.functionCall({
      contractId,
      methodName: "propose",
      args: { kind: d.kind, rationale: d.rationale },
      attachedDeposit: BigInt(utils.format.parseNearAmount("0") ?? "0"),
    });

    const result = outcome.status;
    if (typeof result === "object" && "SuccessValue" in result && result.SuccessValue != null) {
      const proposalId = JSON.parse(
        Buffer.from(result.SuccessValue, "base64").toString()
      ) as number;
      console.log(`  -> proposal #${proposalId} created`);
    } else {
      console.error("  -> call failed:", JSON.stringify(result));
    }
  }
}

// ---- entrypoint -----------------------------------------------------------

console.log("Fetching treasury context...");
const ctx = await fetchTreasuryContext();
console.log("Treasury context:", JSON.stringify(ctx, null, 2));

const drafts = await draftProposals(ctx);
console.log(`Drafted ${drafts.length} proposal(s)`);
await submit(drafts);
