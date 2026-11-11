// AI proposer: private books in, TEE-signed proposals out, verified on chain.
//
// 1. Reads the treasury state from chain and the merchant's private books from
//    data/books.json (falls back to data/books.example.json).
// 2. Fetches the model's attestation report with a fresh nonce and verifies the TDX quote and
//    key binding (logged; the contract relies on the governance-registered key instead).
// 3. Sends one non-streaming completion to a model NEAR AI Cloud runs inside its TEE.
// 4. Fetches the TEE's ECDSA signature over "{model}:{sha256(request)}:{sha256(response)}".
// 5. Submits the exact response bytes + signature with `propose_attested`. The contract
//    recovers the signer, checks it was registered by governance, and parses the proposals
//    from the signed output. The books never go on chain; only their hash does.
//
// The proposer account MUST use a function-call key limited to the treasury's `propose` and
// `propose_attested`. It can never approve or execute.
//
//   npm run propose               # full run
//   DRY_RUN=true npm run propose  # everything except the on-chain submit

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../.env"), quiet: true });

import { fetchResponseSignature, type ResponseSignature } from "./near-ai-evidence.js";
import { DEFAULT_MODEL, getEnv, nearAccount } from "./near.js";
import { printVerification, verifyModelKey } from "./tee-verify.js";

type ProposalKind =
  | { Payout: { to: string; token: string | null; amount: string } }
  | { Allocate: { venue: string; token: string; amount: string } }
  | { Withdraw: { venue: string; amount: string } }
  | { PayInvoice: { invoice_id: number } };

/** On-chain invoice (public). */
interface Invoice {
  id: number;
  issuer: string;
  holder: string;
  token: string;
  amount: string;
  due_ms: number;
  reference: string;
  status: "Open" | "Paid" | "Cancelled";
  pending_proposal: number | null;
}

interface Draft {
  kind: ProposalKind;
  rationale: string;
}

interface AutonomyStatus {
  policy: { token: string; max_per_payout: string; daily_cap: string; veto_window_ms: number } | null;
  spent: string;
  committed: string;
  remaining: string;
}

const sha256Hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

// ---- treasury context (public, on chain) --------------------------------------

async function treasuryContext() {
  const contractId = getEnv("TREASURY_CONTRACT_ID");
  const account = await nearAccount();
  const view = <T>(methodName: string, args: object = {}) =>
    account.viewFunction({ contractId, methodName, args }) as Promise<T>;

  const policy = await view<{ stable_token: string; max_total_allocated: string; reserve_floor: string } | null>(
    "get_policy"
  );
  if (!policy) throw new Error("Treasury policy not set; pass a SetPolicy proposal first.");
  // v2 views. A v1 contract (before the upgrade) lacks them; dry runs continue with empty values.
  let isV2 = true;
  const v2 = <T>(methodName: string, fallback: T) =>
    view<T>(methodName).catch((err: unknown) => {
      const type = (err as { type?: string }).type ?? "";
      if (!/MethodNotFound|MethodResolveError|method is not found/i.test(`${type} ${String(err)}`)) throw err;
      isV2 = false;
      return fallback;
    });
  const noAutonomy: AutonomyStatus = { policy: null, spent: "0", committed: "0", remaining: "0" };
  const [totalAllocated, positions, vendors, autonomy, modelSigners, balance] = await Promise.all([
    view<string>("get_total_allocated"),
    view<[string, string][]>("get_positions"),
    v2<string[]>("list_vendors", []),
    v2<AutonomyStatus>("get_autonomy", noAutonomy),
    v2<[string, string][]>("list_model_signers", []),
    account.viewFunction({
      contractId: policy.stable_token,
      methodName: "ft_balance_of",
      args: { account_id: contractId },
    }) as Promise<string>,
  ]);
  // The contract has no list of whitelisted venues; check the configured candidates.
  const candidates = (process.env.YIELD_VENUES ?? "ghoststore-venue.testnet")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const caps = await Promise.all(candidates.map((venue) => view<string | null>("get_venue_cap", { venue })));
  const venues = candidates
    .map((venue, i) => ({ venue, cap: caps[i] }))
    .filter((v): v is { venue: string; cap: string } => !!v.cap);

  // Open invoices nobody is paying yet. Public data; the AI matches them against the books.
  const invoices: Invoice[] = [];
  if (isV2) {
    for (let from = 0; ; from += 100) {
      const page = await view<Invoice[]>("list_invoices", { from, limit: 100 });
      invoices.push(...page);
      if (page.length < 100) break;
    }
  }
  // Pending proposals, so a bill already being paid by a raw Payout is not paid twice.
  const pendingPayouts: { to: string; token: string | null; amount: string }[] = [];
  for (let from = 0; ; from += 100) {
    const page = await view<{ status: string; kind: Record<string, any> }[]>("list_proposals", { from, limit: 100 });
    for (const p of page) {
      if (p.status === "Pending" && p.kind.Payout) pendingPayouts.push(p.kind.Payout);
    }
    if (page.length < 100) break;
  }

  return { contractId, policy, totalAllocated, positions, vendors, autonomy, modelSigners, balance, isV2, venues, invoices, pendingPayouts };
}

// ---- private books (never on chain) ---------------------------------------------

function loadBooks(): { path: string; books: unknown } {
  const dataDir = resolve(here, "../data");
  const path = [resolve(dataDir, "books.json"), resolve(dataDir, "books.example.json")].find(existsSync);
  if (!path) throw new Error("No data/books.json or data/books.example.json");
  return { path, books: JSON.parse(readFileSync(path, "utf8")) };
}

// ---- prompt ---------------------------------------------------------------------

/** Raw 6-decimal units to a human USDT number, for the model's reasoning. */
const usdt = (raw: string) => Number(BigInt(raw)) / 1e6;
/** Human USDT to raw 6-decimal units (bills in the books are in whole USDT). */
const toRaw = (human: number) => BigInt(Math.round(human * 1e6)).toString();

interface Bill {
  vendor: string;
  vendor_account: string;
  invoice: string;
  amount: number;
  due: string;
  note?: string;
}

type BillState =
  | { status: "pay_invoice"; invoice_id: number }
  | { status: "no_invoice" }
  | { status: "payment_pending"; by: string }
  | { status: "already_paid"; invoice_id: number };

/**
 * Deterministic reconciliation of the private bills against public chain state. An invoice
 * matches a bill only if issuer, reference, token and exact amount all agree. The model then
 * decides what to pay (due dates, cash), but it cannot pay an unmatched invoice or pay a bill
 * twice: the output schema only admits matched invoice ids and bills with no invoice.
 */
function reconcile(bills: Bill[], ctx: Awaited<ReturnType<typeof treasuryContext>>) {
  const stable = ctx.policy.stable_token;
  const used = new Set<number>();
  const states = bills.map((b): Bill & BillState => {
    const raw = toRaw(b.amount);
    const inv = ctx.invoices.find(
      (i) =>
        i.status !== "Cancelled" &&
        i.issuer === b.vendor_account &&
        i.reference === b.invoice &&
        i.token === stable &&
        i.amount === raw &&
        !used.has(i.id)
    );
    if (inv) {
      used.add(inv.id);
      if (inv.status === "Paid") return { ...b, status: "already_paid", invoice_id: inv.id };
      if (inv.pending_proposal !== null)
        return { ...b, status: "payment_pending", by: `proposal #${inv.pending_proposal}` };
      return { ...b, status: "pay_invoice", invoice_id: inv.id };
    }
    const pendingPayout = ctx.pendingPayouts.some(
      (p) => p.to === b.vendor_account && p.token === stable && p.amount === raw
    );
    if (pendingPayout) return { ...b, status: "payment_pending", by: "a pending Payout" };
    return { ...b, status: "no_invoice" };
  });
  const unmatched = ctx.invoices.filter((i) => i.status === "Open" && !used.has(i.id));
  return { states, unmatched };
}

function buildRequest(model: string, ctx: Awaited<ReturnType<typeof treasuryContext>>, books: unknown): string {
  const stable = ctx.policy.stable_token;
  const bills = ((books as { bills?: Bill[] }).bills ?? []).filter(
    (b) => typeof b.vendor_account === "string" && typeof b.amount === "number"
  );
  const { states, unmatched } = reconcile(bills, ctx);
  // Hard limits on what can be named. Invoices: only ones matched to a bill. Payouts: only to
  // bills with no invoice and no payment in flight. Venues: only whitelisted ones. One invalid
  // draft would make the whole signed batch fail on chain.
  const payees = [...new Set(states.filter((b) => b.status === "no_invoice").map((b) => b.vendor_account))];
  const venueIds = ctx.venues.map((v) => v.venue);
  const invoiceIds = states.flatMap((b) => (b.status === "pay_invoice" ? [b.invoice_id] : []));
  const positionVenues = ctx.positions.map(([v]) => v);
  const system = [
    "You are the treasury agent for a small merchant. You draft proposals; humans and an on-chain policy decide.",
    "Reply with ONLY a JSON array (no prose, no markdown) of at most 5 items shaped {\"kind\": ..., \"rationale\": \"...\"}.",
    `Example item: {"kind":{"PayInvoice":{"invoice_id":3}},"rationale":"Matches bill PKG-2291, due in 2 days"}`,
    "Allowed kinds:",
    '  {"PayInvoice":{"invoice_id":<id from open_invoices>}}  (pays the invoice holder its exact amount)',
    `  {"Payout":{"to":"<vendor_account>","token":"${stable}","amount":"<integer string>"}}`,
    `  {"Allocate":{"venue":"<whitelisted venue>","token":"${stable}","amount":"<integer string>"}}`,
    '  {"Withdraw":{"venue":"<venue with a position>","amount":"<integer string>"}}',
    "The input gives every figure in whole USDT. In your OUTPUT, amounts are integer strings in the token's smallest unit:",
    `${stable} has 6 decimals, so 40 USDT is "40000000" and 25.5 USDT is "25500000".`,
    "bills_to_settle lists each bill with a status computed from the chain. For bills due within 14 days:",
    "  status pay_invoice: propose PayInvoice with that invoice_id.",
    "  status no_invoice: propose a Payout of exactly the billed amount to its vendor_account.",
    "  status payment_pending or already_paid: propose nothing for it.",
    "Never pay anything in unmatched_invoices: no bill in the books backs them.",
    "Never pay an account that is not a bill's vendor_account.",
    "Only allocate idle cash to a whitelisted venue, and only if the liquid balance after all payouts stays above the reserve floor plus 30 days of payroll.",
    "If nothing should happen, reply with an empty array [].",
    "Rationales must be under 300 characters and must NOT contain customer names, emails, revenue figures or other private data from the books.",
    "Invoice payments from allowlisted vendors within the limits execute automatically after a veto window; everything else waits for signers.",
  ].join("\n");

  const a = ctx.autonomy.policy;
  const user = JSON.stringify({
    today: new Date().toISOString().slice(0, 10),
    treasury_in_usdt: {
      account: ctx.contractId,
      stable_token: stable,
      liquid_balance: usdt(ctx.balance),
      reserve_floor: usdt(ctx.policy.reserve_floor),
      max_total_allocated: usdt(ctx.policy.max_total_allocated),
      total_allocated: usdt(ctx.totalAllocated),
      positions: ctx.positions.map(([venue, raw]) => ({ venue, principal: usdt(raw) })),
      whitelisted_venues: ctx.venues.map((v) => ({ venue: v.venue, cap: usdt(v.cap) })),
      autonomy_allowlist: ctx.vendors,
      autonomy_policy: a && {
        max_per_payout: usdt(a.max_per_payout),
        daily_cap: usdt(a.daily_cap),
        veto_window_minutes: a.veto_window_ms / 60_000,
      },
      autonomy_remaining_today: usdt(ctx.autonomy.remaining),
    },
    bills_to_settle: states.map((b) => ({
      vendor_account: b.vendor_account,
      invoice: b.invoice,
      amount_usdt: b.amount,
      due: b.due,
      status: b.status,
      ...("invoice_id" in b ? { invoice_id: b.invoice_id } : {}),
      ...("by" in b ? { pending_via: b.by } : {}),
    })),
    unmatched_invoices: unmatched.map((i) => ({
      invoice_id: i.id,
      issuer: i.issuer,
      reference: i.reference,
      amount_usdt: i.token === stable ? usdt(i.amount) : null,
    })),
    books,
  });

  const amount = { type: "string", pattern: "^[1-9][0-9]*$" };
  const oneOf = (values: string[]) => ({ type: "string", enum: values });
  const variant = (name: string, fields: Record<string, unknown>) => ({
    type: "object",
    properties: { [name]: { type: "object", properties: fields, required: Object.keys(fields), additionalProperties: false } },
    required: [name],
    additionalProperties: false,
  });
  const kinds = [
    invoiceIds.length && variant("PayInvoice", { invoice_id: { type: "integer", enum: invoiceIds } }),
    payees.length && variant("Payout", { to: oneOf(payees), token: oneOf([stable]), amount }),
    venueIds.length && variant("Allocate", { venue: oneOf(venueIds), token: oneOf([stable]), amount }),
    positionVenues.length && variant("Withdraw", { venue: oneOf(positionVenues), amount }),
  ].filter(Boolean);
  // Constrained decoding: the output must match the contract's Draft list exactly. With nothing
  // allowed (everything settled or pending), the only valid answer is an empty list.
  const schema = {
    type: "array",
    maxItems: kinds.length ? 5 : 0,
    items: {
      type: "object",
      properties: {
        kind: kinds.length ? { anyOf: kinds } : { type: "object" },
        rationale: { type: "string", maxLength: 300 },
      },
      required: ["kind", "rationale"],
      additionalProperties: false,
    },
  };

  return JSON.stringify({
    model,
    stream: false,
    temperature: 0,
    max_tokens: 1500,
    response_format: { type: "json_schema", json_schema: { name: "drafts", strict: true, schema } },
    // Qwen3 reasoning off: the signed output should be the JSON answer only.
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
}

// ---- local checks (the contract re-checks everything) -----------------------------

function parseDrafts(content: string): Draft[] {
  const drafts = JSON.parse(content.trim()) as unknown;
  if (!Array.isArray(drafts)) throw new Error("Model output is not an array");
  if (drafts.length > 5) throw new Error("Model returned more than 5 drafts");
  // One pending proposal per invoice on chain: a repeat would fail the whole signed batch.
  const invoiceIds = (drafts as Draft[])
    .map((d) => ("PayInvoice" in (d.kind ?? {}) ? (d.kind as { PayInvoice: { invoice_id: number } }).PayInvoice.invoice_id : null))
    .filter((v): v is number => v !== null);
  if (new Set(invoiceIds).size !== invoiceIds.length) throw new Error("Model named the same invoice twice");
  for (const d of drafts as Draft[]) {
    const keys = Object.keys(d.kind ?? {});
    if (keys.length !== 1 || !["Payout", "PayInvoice", "Allocate", "Withdraw"].includes(keys[0]))
      throw new Error(`Unsupported kind: ${JSON.stringify(d.kind)}`);
    if (keys[0] === "PayInvoice") {
      const id = (d.kind as { PayInvoice: { invoice_id: unknown } }).PayInvoice.invoice_id;
      if (!Number.isInteger(id) || (id as number) < 0) throw new Error(`Bad invoice id: ${JSON.stringify(d.kind)}`);
      if (typeof d.rationale !== "string" || Buffer.byteLength(d.rationale) > 500)
        throw new Error("Rationale missing or over 500 bytes");
      continue;
    }
    const amount = (Object.values(d.kind)[0] as { amount?: unknown }).amount;
    if (typeof amount !== "string" || !/^[1-9][0-9]*$/.test(amount))
      throw new Error(`Amount must be a positive integer string: ${JSON.stringify(d.kind)}`);
    if (typeof d.rationale !== "string" || Buffer.byteLength(d.rationale) > 500)
      throw new Error("Rationale missing or over 500 bytes");
  }
  return drafts as Draft[];
}

async function signatureWithRetry(baseUrl: string, apiKey: string, chatId: string): Promise<ResponseSignature> {
  for (let i = 0; i < 6; i++) {
    const sig = await fetchResponseSignature({ baseUrl, apiKey, chatId });
    if (sig) return sig;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`No TEE signature for chat ${chatId}`);
}

// ---- main ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === "true";
  const model = process.env.NEAR_AI_MODEL || DEFAULT_MODEL;
  const baseUrl = getEnv("NEAR_AI_BASE_URL").replace(/\/+$/, "");
  const apiKey = getEnv("NEAR_AI_API_KEY");

  const ctx = await treasuryContext();
  const { path: booksPath, books } = loadBooks();
  console.log(`Treasury ${ctx.contractId}: balance ${ctx.balance}, floor ${ctx.policy.reserve_floor}`);
  console.log(`Books: ${booksPath} (sent only to the TEE model)`);

  // Fresh attestation check for this model. Informational: the contract trusts only keys that
  // signers registered (after running the same check with `npm run register-model`).
  try {
    printVerification(await verifyModelKey({ baseUrl, apiKey, model }));
  } catch (err) {
    console.warn(`TEE report check skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // One completion. Keep the exact bytes: their hash is what the TEE signs.
  const requestBody = buildRequest(model, ctx, books);
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: requestBody,
  });
  const responseBytes = new Uint8Array(await res.arrayBuffer());
  const responseText = new TextDecoder().decode(responseBytes);
  if (!res.ok) throw new Error(`Completion failed (HTTP ${res.status}): ${responseText.slice(0, 300)}`);

  const body = JSON.parse(responseText);
  const content: string | undefined = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Completion has no message content");
  let drafts: Draft[];
  try {
    drafts = parseDrafts(content);
  } catch (err) {
    console.error(`Model output:\n${content}`);
    throw err;
  }
  const requestHash = sha256Hex(requestBody);
  const responseHash = sha256Hex(responseBytes);

  const sig = await signatureWithRetry(baseUrl, apiKey, String(body.id));
  const expectedText = `${model}:${requestHash}:${responseHash}`;
  if (sig.signature_kind !== "provider_tee") throw new Error(`Signature is ${sig.signature_kind}, not provider_tee`);
  if (sig.text !== expectedText) throw new Error(`Signed text mismatch:\n  got      ${sig.text}\n  expected ${expectedText}`);
  const signer = sig.signing_address.toLowerCase();
  console.log(`TEE signature by ${signer} over response ${responseHash.slice(0, 16)}…`);

  for (const d of drafts) console.log(`  draft ${JSON.stringify(d.kind)}  "${d.rationale}"`);
  if (drafts.length === 0) {
    console.log("The model proposed nothing this run.");
    return;
  }

  // Optional: keep the exact signed evidence (e.g. as a contract test fixture). Contains no
  // books, only the model output, the request hash and the TEE signature.
  if (process.env.SAVE_EVIDENCE) {
    writeFileSync(
      process.env.SAVE_EVIDENCE,
      JSON.stringify(
        { model, request_hash: requestHash, response: responseText, signature: sig.signature, signer },
        null,
        2
      )
    );
    console.log(`Saved signed evidence to ${process.env.SAVE_EVIDENCE}`);
  }

  const registered = ctx.modelSigners.some(([a, m]) => a === signer && m === model);
  if (!ctx.isV2) {
    const msg = `${ctx.contractId} runs the v1 contract (no propose_attested). Run agent/scripts/testnet-v2-setup.mjs.`;
    if (dryRun) {
      console.log(`DRY_RUN=true: ${msg}`);
      return;
    }
    throw new Error(msg);
  }
  if (!registered) {
    throw new Error(
      `TEE key ${signer} is not registered for ${model} on ${ctx.contractId}. ` +
        "Run `npm run register-model -- --propose` and have the signers approve it."
    );
  }
  if (dryRun) {
    console.log("DRY_RUN=true: not submitting.");
    return;
  }

  const account = await nearAccount();
  const outcome = await account.functionCall({
    contractId: ctx.contractId,
    methodName: "propose_attested",
    args: {
      model,
      request_hash: requestHash,
      response: Buffer.from(responseBytes).toString("base64"),
      signature: sig.signature,
    },
    gas: 150_000_000_000_000n, // 150 Tgas
  });
  const status = outcome.status as { SuccessValue?: string; Failure?: unknown };
  if (!status.SuccessValue) throw new Error(`propose_attested failed: ${JSON.stringify(status)}`);
  const ids = JSON.parse(Buffer.from(status.SuccessValue, "base64").toString()) as number[];
  console.log(`Created proposals ${ids.map((i) => `#${i}`).join(", ")} (tx ${outcome.transaction.hash})`);

  for (const id of ids) {
    const p = (await account.viewFunction({
      contractId: ctx.contractId,
      methodName: "get_proposal",
      args: { id },
    })) as { auto_execute_after_ms: number | null };
    console.log(
      p.auto_execute_after_ms
        ? `  #${id}: autonomy lane, executable after ${new Date(p.auto_execute_after_ms).toISOString()} unless vetoed`
        : `  #${id}: needs signer approval`
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
