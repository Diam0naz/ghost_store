// Cold vault (docs/COLD-VAULT.md): live reads and the calls guardians and the device make.

import { useQuery } from "@tanstack/react-query";
import { JsonRpcProvider } from "@near-js/providers";
import { RPC_URL, callContractOn, viewCall } from "./near";

export const DEFAULT_VAULT_ID = process.env.NEXT_PUBLIC_COLD_VAULT_ID ?? "";
const VAULT_KEY = "ghost.vault";

export interface VaultLimits {
  release_delay_ms: number;
  installments: number;
  installment_interval_ms: number;
  weekly_cap: string;
  change_delay_ms: number;
}

export interface VaultStatus {
  token: string;
  destination: string;
  guardians: string[];
  threshold: number;
  device_key: string;
  limits: VaultLimits;
  frozen: boolean;
  unfreeze_approvals: string[];
  held: string;
  committed: string;
  available: string;
  released_this_week: string;
}

export interface VaultRequest {
  id: number;
  amount: string;
  paid: string;
  installments_paid: number;
  installments: number;
  installment_interval_ms: number;
  note: string;
  created_at_ms: number;
  first_release_at_ms: number;
  status: "Pending" | "Completed" | "Cancelled";
  cancelled_by: string | null;
}

export type VaultChangeKind =
  | { SetDevice: { key: string } }
  | { SetDestination: { account_id: string } }
  | { SetLimits: { limits: VaultLimits } }
  | { SetGuardians: { guardians: string[]; threshold: number } };

export interface VaultChange {
  id: number;
  kind: VaultChangeKind;
  approvals: string[];
  proposed_at_ms: number;
  executable_after_ms: number | null;
  status: "Pending" | "Applied" | "Cancelled";
}

/** `?vault=<id>` (remembered) or the remembered vault, else the configured one. Browser only. */
export function resolveVaultId(): string {
  if (typeof window === "undefined") return DEFAULT_VAULT_ID;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("vault");
    if (fromUrl && /^[a-z0-9._-]{2,64}$/.test(fromUrl)) {
      window.localStorage.setItem(VAULT_KEY, fromUrl);
      return fromUrl;
    }
    return window.localStorage.getItem(VAULT_KEY) || DEFAULT_VAULT_ID;
  } catch {
    return DEFAULT_VAULT_ID;
  }
}

async function listAll<T>(vault: string, method: string): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += 100) {
    const page = await viewCall<T[]>(vault, method, { from, limit: 100 });
    all.push(...page);
    if (page.length < 100) return all;
  }
}

export function useVault(vault: string) {
  return useQuery({
    queryKey: ["vault", vault],
    queryFn: async () => {
      const [status, requests, changes] = await Promise.all([
        viewCall<VaultStatus>(vault, "get_status"),
        listAll<VaultRequest>(vault, "list_requests"),
        listAll<VaultChange>(vault, "list_changes"),
      ]);
      return { status, requests: requests.reverse(), changes: changes.reverse() };
    },
    enabled: !!vault,
    refetchInterval: 10_000,
  });
}

/** Public keys on an account, to tell whether the connected wallet holds the device key. */
export function useAccountKeys(accountId: string | null) {
  return useQuery<string[]>({
    queryKey: ["access-keys", accountId],
    queryFn: async () => {
      const provider = new JsonRpcProvider({ url: RPC_URL });
      const r = (await provider.query({
        request_type: "view_access_key_list",
        account_id: accountId!,
        finality: "optimistic",
      })) as unknown as { keys: { public_key: string }[] };
      return r.keys.map((k) => k.public_key);
    },
    enabled: !!accountId,
    staleTime: 60_000,
  });
}

/** Installments whose time has come (paid or not). */
export function dueInstallments(r: VaultRequest, now: number): number {
  if (now < r.first_release_at_ms) return 0;
  return Math.min(r.installments, 1 + Math.floor((now - r.first_release_at_ms) / r.installment_interval_ms));
}

export function nextInstallmentAt(r: VaultRequest): number {
  return r.first_release_at_ms + r.installments_paid * r.installment_interval_ms;
}

export function humanDuration(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)} min`;
  if (h < 48 && h % 24 !== 0) return `${Math.round(h)} h`;
  const d = h / 24;
  return `${Number.isInteger(d) ? d : d.toFixed(1)} day${d === 1 ? "" : "s"}`;
}

export function toUnits(input: string, decimals: number): string {
  const [w = "0", f = ""] = input.trim().split(".");
  return (BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0")).toString();
}

const GAS = "30000000000000";
export const vaultCalls = {
  request: (v: string, amount: string, note: string) => callContractOn(v, "request_release", { amount, note }, "0", GAS),
  release: (v: string, id: number) => callContractOn(v, "release", { id }, "0", "60000000000000"),
  cancel: (v: string, id: number) => callContractOn(v, "cancel_request", { id }, "0", GAS),
  freeze: (v: string) => callContractOn(v, "freeze", {}, "0", GAS),
  approveUnfreeze: (v: string) => callContractOn(v, "approve_unfreeze", {}, "0", GAS),
  proposeDevice: (v: string, key: string) => callContractOn(v, "propose_change", { kind: { SetDevice: { key } } }, "0", GAS),
  approveChange: (v: string, id: number) => callContractOn(v, "approve_change", { id }, "0", GAS),
  cancelChange: (v: string, id: number) => callContractOn(v, "cancel_change", { id }, "0", GAS),
  applyChange: (v: string, id: number) => callContractOn(v, "apply_change", { id }, "0", GAS),
};

export function describeChange(k: VaultChangeKind): string {
  if ("SetDevice" in k) return `Replace the device key with ${k.SetDevice.key.slice(0, 18)}…`;
  if ("SetDestination" in k) return `Send releases to ${k.SetDestination.account_id} instead`;
  if ("SetGuardians" in k) return `Guardians: ${k.SetGuardians.guardians.join(", ")} (${k.SetGuardians.threshold} needed)`;
  const l = k.SetLimits.limits;
  return `Limits: ${humanDuration(l.release_delay_ms)} delay, ${l.installments} installments every ${humanDuration(l.installment_interval_ms)}`;
}
