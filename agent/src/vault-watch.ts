// Cold vault watch, run by the keeper (docs/COLD-VAULT.md).
//
// The vault's protection is a delay that any one guardian can use to cancel or freeze, so the
// keeper's main job here is to make sure guardians hear about everything in time:
//   - every new release request (with a cancel/freeze prompt),
//   - every freeze and unfreeze,
//   - every rule change when proposed and when its delay starts,
//   - every cancelled request.
// It also pays installments that are due by calling the permissionless `release`, when it has a
// key that may call the vault (KEEPER_VAULT_ACCOUNT_ID + KEEPER_VAULT_PRIVATE_KEY: a function-call
// key for `release` on the vault). Without one it only alerts.

import type { Account } from "near-api-js";

interface Request {
  id: number;
  amount: string;
  paid: string;
  installments_paid: number;
  installments: number;
  installment_interval_ms: number;
  note: string;
  first_release_at_ms: number;
  status: "Pending" | "Completed" | "Cancelled";
  cancelled_by: string | null;
}

interface Change {
  id: number;
  kind: Record<string, Record<string, unknown>>;
  approvals: string[];
  executable_after_ms: number | null;
  status: "Pending" | "Applied" | "Cancelled";
}

interface Status {
  token: string;
  destination: string;
  guardians: string[];
  threshold: number;
  frozen: boolean;
  held: string;
  available: string;
  limits: { weekly_cap: string };
}

export interface VaultWatchDeps {
  /** Account used for view calls. */
  viewer: Account;
  /** Account allowed to call `release` on the vault, or null to only alert. */
  releaser: Account | null;
  vaultId: string;
  alert: (text: string) => Promise<void>;
  /** "35 USDT.e" from a token and raw base units. */
  amount: (token: string, raw: string) => Promise<string>;
  /** Link to where guardians act, if configured. */
  link?: string;
  now?: () => number;
}

const seenRequests = new Map<number, Request["status"]>();
const seenChanges = new Map<number, string>();
const releaseFailed = new Set<string>();
let lastFrozen: boolean | null = null;

async function listAll<T>(viewer: Account, contractId: string, methodName: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 100) {
    const page = (await viewer.viewFunction({ contractId, methodName, args: { from, limit: 100 } })) as T[];
    out.push(...page);
    if (page.length < 100) return out;
  }
}

function when(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

function describeChange(c: Change): string {
  const [name, args] = Object.entries(c.kind)[0] ?? ["Unknown", {}];
  switch (name) {
    case "SetDevice":
      return `replace the device key with ${String(args.key)}`;
    case "SetDestination":
      return `send releases to ${String(args.account_id)} instead`;
    case "SetGuardians":
      return `set guardians to ${(args.guardians as string[]).join(", ")} (${String(args.threshold)} needed)`;
    case "SetLimits":
      return `change limits to ${JSON.stringify(args.limits)}`;
    default:
      return name;
  }
}

/** Installments whose time has come for a request (paid or not). */
export function dueInstallments(r: Request, now: number): number {
  if (now < r.first_release_at_ms) return 0;
  return Math.min(r.installments, 1 + Math.floor((now - r.first_release_at_ms) / r.installment_interval_ms));
}

export async function vaultPass(d: VaultWatchDeps): Promise<void> {
  const now = (d.now ?? Date.now)();
  const v = d.vaultId;
  const act = d.link ? `\nAct: ${d.link}` : "";
  const status = (await d.viewer.viewFunction({ contractId: v, methodName: "get_status" })) as Status;

  // Freeze / unfreeze (and the state at startup, if frozen).
  if (lastFrozen !== status.frozen) {
    if (status.frozen) await d.alert(`Cold vault ${v} is FROZEN: no requests or releases until ${status.threshold} guardian(s) approve unfreezing.${act}`);
    else if (lastFrozen === true) await d.alert(`Cold vault ${v} was unfrozen by the guardians.`);
    lastFrozen = status.frozen;
  }

  // Requests: alert on new ones and cancellations; pay due installments.
  for (const r of await listAll<Request>(d.viewer, v, "list_requests")) {
    const prev = seenRequests.get(r.id);
    const total = await d.amount(status.token, r.amount);
    if (prev === undefined && r.status === "Pending") {
      await d.alert(
        `Cold vault ${v}: release request #${r.id} for ${total}${r.note ? ` ("${r.note}")` : ""}.\n` +
          `Pays ${r.installments} installment(s) to ${status.destination}, the first at ${when(r.first_release_at_ms)}.\n` +
          `If nobody on your team asked for this, any guardian can cancel it or freeze the vault now.${act}`
      );
    }
    if (prev !== undefined && prev !== "Cancelled" && r.status === "Cancelled") {
      await d.alert(`Cold vault ${v}: request #${r.id} (${total}) was cancelled by ${r.cancelled_by ?? "a guardian"}.`);
    }
    seenRequests.set(r.id, r.status);

    if (r.status !== "Pending" || status.frozen || dueInstallments(r, now) <= r.installments_paid) continue;
    const nth = r.installments_paid + 1;
    const key = `${r.id}:${r.installments_paid}`;
    if (!d.releaser) {
      if (!releaseFailed.has(key)) {
        releaseFailed.add(key);
        console.log(`vault: installment ${nth}/${r.installments} of #${r.id} is due; no KEEPER_VAULT key, anyone can call release(${r.id}).`);
      }
      continue;
    }
    try {
      const out = await d.releaser.functionCall({
        contractId: v,
        methodName: "release",
        args: { id: r.id },
        gas: 50_000_000_000_000n,
      });
      await d.alert(
        `Cold vault ${v}: released installment ${nth}/${r.installments} of request #${r.id} to ${status.destination}.\nTx: ${out.transaction.hash}`
      );
    } catch (err) {
      if (releaseFailed.has(key)) continue; // alert once per installment, keep retrying quietly
      releaseFailed.add(key);
      const reason = err instanceof Error ? err.message : String(err);
      await d.alert(`Cold vault ${v}: installment ${nth} of request #${r.id} was NOT released.\nReason: ${reason.slice(0, 300)}`);
    }
  }

  // Rule changes: alert when proposed and when their delay starts.
  for (const c of await listAll<Change>(d.viewer, v, "list_changes")) {
    const state = `${c.status}:${c.executable_after_ms ?? ""}`;
    const prev = seenChanges.get(c.id);
    seenChanges.set(c.id, state);
    if (prev === state || c.status !== "Pending") continue;
    if (c.executable_after_ms === null) {
      await d.alert(
        `Cold vault ${v}: guardian change #${c.id} proposed: ${describeChange(c)}. Approvals ${c.approvals.length}/${status.threshold} (${c.approvals.join(", ")}).${act}`
      );
    } else {
      await d.alert(
        `Cold vault ${v}: change #${c.id} (${describeChange(c)}) has its approvals and takes effect after ${when(c.executable_after_ms)} unless a guardian cancels it.${act}`
      );
    }
  }
}

/** For tests: forget what was seen. */
export function resetVaultWatch(): void {
  seenRequests.clear();
  seenChanges.clear();
  releaseFailed.clear();
  lastFrozen = null;
}
