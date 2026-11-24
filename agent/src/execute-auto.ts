// Keeper: execute autonomy-lane payouts whose veto window has ended, and alert the signers
// when a payout enters its veto window so someone can still veto it.
// `execute_auto` is permissionless, so any account can run this; the proposer's function-call
// key needs `execute_auto` in its allowed methods.
//
//   npm run execute-auto        # one pass, then exit
//   npm run keeper              # keep running: poll every KEEPER_INTERVAL_S seconds (default 20)
//
// Alerts (optional, both can be set):
//   ALERT_WEBHOOK_URL                      Slack or Discord incoming webhook
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID  Telegram bot message
//   TREASURY_UI_URL                        link added to alerts, e.g. https://<app>/treasury
//
// Cold vault (optional, docs/COLD-VAULT.md):
//   COLD_VAULT_ID                          alert guardians on requests, freezes and rule changes
//   KEEPER_VAULT_ACCOUNT_ID + KEEPER_VAULT_PRIVATE_KEY
//                                          a key that may call `release` on the vault, so the
//                                          keeper pays due installments (else it only alerts)
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

import type { Account } from "near-api-js";
import { accountFor, getEnv, nearAccount } from "./near.js";
import { vaultPass } from "./vault-watch.js";

type Kind = Record<string, Record<string, unknown>>;

export interface Proposal {
  id: number;
  kind: Kind;
  rationale?: string;
  status: string;
  created_at_ms: number;
  auto_execute_after_ms: number | null;
}

interface Invoice {
  id: number;
  issuer: string;
  token: string;
  amount: string;
  reference: string;
}

const WATCH = process.argv.includes("--watch");
const INTERVAL_MS = Math.max(5, Number(process.env.KEEPER_INTERVAL_S ?? 20)) * 1000;

async function listPending(account: Account, contractId: string): Promise<Proposal[]> {
  const out: Proposal[] = [];
  for (let from = 0; ; from += 100) {
    const page = (await account.viewFunction({
      contractId,
      methodName: "list_proposals",
      args: { from, limit: 100 },
    })) as Proposal[];
    out.push(...page.filter((p) => p.status === "Pending" && p.auto_execute_after_ms !== null));
    if (page.length < 100) break;
  }
  return out;
}

const metaCache = new Map<string, { decimals: number; symbol: string }>();
async function tokenMeta(account: Account, token: string): Promise<{ decimals: number; symbol: string }> {
  if (!metaCache.has(token)) {
    try {
      const m = (await account.viewFunction({ contractId: token, methodName: "ft_metadata" })) as { decimals: number; symbol: string };
      metaCache.set(token, { decimals: m.decimals, symbol: m.symbol || token });
    } catch {
      metaCache.set(token, { decimals: 0, symbol: token });
    }
  }
  return metaCache.get(token)!;
}

/** "35 USDT.e" from raw base units. */
async function amountText(account: Account, token: string, raw: string): Promise<string> {
  const m = await tokenMeta(account, token);
  return `${formatUnits(raw, m.decimals)} ${m.symbol}`;
}

export function formatUnits(raw: string, dec: number): string {
  if (dec === 0) return raw;
  const s = raw.padStart(dec + 1, "0");
  const frac = s.slice(-dec).replace(/0+$/, "");
  return s.slice(0, -dec) + (frac ? `.${frac}` : "");
}

/** One line saying what the payout does, e.g. "pay invoice PKG-2310: 35 to packaging.x". */
export async function describe(account: Account, contractId: string, p: Proposal): Promise<string> {
  const [name, args] = Object.entries(p.kind)[0] ?? ["Unknown", {}];
  if (name === "PayInvoice") {
    const inv = (await account.viewFunction({
      contractId,
      methodName: "get_invoice",
      args: { invoice_id: args.invoice_id },
    })) as Invoice | null;
    if (!inv) return `pay invoice #${String(args.invoice_id)}`;
    return `pay invoice ${inv.reference}: ${await amountText(account, inv.token, inv.amount)} to ${inv.issuer}`;
  }
  if (name === "Payout" && typeof args.amount === "string" && typeof args.token === "string") {
    return `payout ${await amountText(account, args.token, args.amount)} to ${String(args.to)}`;
  }
  return name;
}

export async function sendAlert(text: string): Promise<void> {
  const sends: Promise<unknown>[] = [];
  const hook = process.env.ALERT_WEBHOOK_URL;
  if (hook) {
    // Slack reads `text`, Discord reads `content`.
    sends.push(
      fetch(hook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, content: text }),
        signal: AbortSignal.timeout(10_000),
      }).then((r) => {
        if (!r.ok) throw new Error(`webhook answered ${r.status}`);
      })
    );
  }
  const tg = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (tg && chat) {
    sends.push(
      fetch(`https://api.telegram.org/bot${tg}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      }).then((r) => {
        if (!r.ok) throw new Error(`telegram answered ${r.status}`);
      })
    );
  }
  for (const r of await Promise.allSettled(sends)) {
    if (r.status === "rejected") console.error(`alert not sent: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
  }
}

const alerted = new Set<number>();
const failed = new Set<number>();

async function pass(account: Account, contractId: string): Promise<void> {
  const now = Date.now();
  const pending = await listPending(account, contractId);
  const link = process.env.TREASURY_UI_URL ? `\nVeto: ${process.env.TREASURY_UI_URL}` : "";

  // Alert once per payout while its veto window is still open.
  for (const p of pending) {
    const after = p.auto_execute_after_ms!;
    if (after <= now || alerted.has(p.id)) continue;
    alerted.add(p.id);
    const mins = Math.max(1, Math.round((after - now) / 60_000));
    const what = await describe(account, contractId, p);
    const msg = `Ghost Store treasury: autonomy payout #${p.id} will execute in about ${mins} min (${new Date(after).toISOString()}) unless a signer vetoes it.\n${what}${p.rationale ? `\nAI rationale: ${p.rationale}` : ""}${link}`;
    console.log(msg);
    await sendAlert(msg);
  }

  const due = pending.filter((p) => p.auto_execute_after_ms! <= now);
  if (due.length === 0) {
    if (!WATCH) console.log("No autonomy-lane payouts are due.");
    return;
  }
  for (const p of due) {
    const what = await describe(account, contractId, p);
    try {
      const outcome = await account.functionCall({
        contractId,
        methodName: "execute_auto",
        args: { id: p.id },
        gas: 100_000_000_000_000n,
      });
      console.log(`#${p.id}: tx ${outcome.transaction.hash}`);
      for (const r of outcome.receipts_outcome) for (const l of r.outcome.logs) console.log(`  ${l}`);
      await sendAlert(`Ghost Store treasury: autonomy payout #${p.id} executed with no approvals.\n${what}\nTx: ${outcome.transaction.hash}`);
    } catch (err) {
      // Pause, a removed vendor or a breached reserve floor make the contract refuse it.
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`#${p.id}: not executed: ${reason}`);
      if (!WATCH) process.exitCode = 1;
      if (failed.has(p.id)) continue; // alert once, keep retrying quietly
      failed.add(p.id);
      await sendAlert(`Ghost Store treasury: autonomy payout #${p.id} was NOT executed.\n${what}\nReason: ${reason.slice(0, 300)}`);
    }
  }
}

/** The cold vault watch, if configured. Its failures never stop the treasury keeper. */
async function makeVaultRound(viewer: Account): Promise<(() => Promise<void>) | null> {
  const vaultId = process.env.COLD_VAULT_ID;
  if (!vaultId) return null;
  const id = process.env.KEEPER_VAULT_ACCOUNT_ID;
  const key = process.env.KEEPER_VAULT_PRIVATE_KEY;
  const releaser = id && key ? await accountFor(id, key) : null;
  console.log(`Watching cold vault ${vaultId}; ${releaser ? `releasing due installments as ${id}` : "alerts only (no KEEPER_VAULT key)"}.`);
  return async () => {
    try {
      await vaultPass({
        viewer,
        releaser,
        vaultId,
        alert: async (t) => {
          console.log(t);
          await sendAlert(t);
        },
        amount: (token, raw) => amountText(viewer, token, raw),
        link: process.env.VAULT_UI_URL ?? process.env.TREASURY_UI_URL,
      });
    } catch (err) {
      console.error(`vault pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

async function main(): Promise<void> {
  const contractId = getEnv("TREASURY_CONTRACT_ID");
  const account = await nearAccount();
  const vaultRound = await makeVaultRound(account);
  if (!WATCH) {
    await pass(account, contractId);
    if (vaultRound) await vaultRound();
    return;
  }

  const channels = [process.env.ALERT_WEBHOOK_URL && "webhook", process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID && "Telegram"].filter(Boolean);
  console.log(`Keeper watching ${contractId} every ${INTERVAL_MS / 1000} s; alerts: ${channels.join(", ") || "none (console only)"}. Ctrl+C to stop.`);
  for (;;) {
    try {
      await pass(account, contractId);
    } catch (err) {
      // An RPC hiccup must not stop the keeper; try again next round.
      console.error(`pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (vaultRound) await vaultRound();
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
