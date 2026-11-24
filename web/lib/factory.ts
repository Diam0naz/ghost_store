// Merchant onboarding: the factory contract creates a treasury per shop, then the shop's
// signers apply a starting configuration through the treasury's own governance proposals.

import { useQuery } from "@tanstack/react-query";
import { actionCreators } from "@near-js/transactions";
import {
  FACTORY_CONTRACT_ID,
  DEFAULT_TREASURY_ID,
  viewCall,
  sendActions,
  callContractOn,
} from "./near";

export interface Shop {
  treasury: string;
  display_name: string;
  created_by: string;
  signers: string[];
  threshold: number;
  proposer: string;
  created_at_ms: number;
  status: "Creating" | "Active";
  /** Mainnet account checkout pays (Intents settles on mainnet only). */
  payout_account: string | null;
}

export interface FactoryConfig {
  owner: string;
  treasury_code_hash: string;
  default_proposer: string;
  min_deposit: string;
  shop_count: number;
}

export const ONE_NEAR = 10n ** 24n;
export const CREATE_GAS = "150000000000000";
const SETUP_GAS_EACH = 14_000_000_000_000n;

export function useFactoryConfig() {
  return useQuery<FactoryConfig>({
    queryKey: ["factory-config"],
    queryFn: () => viewCall<FactoryConfig>(FACTORY_CONTRACT_ID, "get_config"),
    enabled: !!FACTORY_CONTRACT_ID,
    staleTime: 60_000,
  });
}

export function useNameAvailable(name: string) {
  return useQuery<boolean>({
    queryKey: ["shop-available", name],
    queryFn: () => viewCall<boolean>(FACTORY_CONTRACT_ID, "is_available", { name }),
    enabled: !!FACTORY_CONTRACT_ID && name.length >= 2,
    staleTime: 5_000,
  });
}

/** Shops the account created or signs for, de-duplicated. */
export function useMyShops(accountId: string | null) {
  return useQuery<Shop[]>({
    queryKey: ["my-shops", accountId],
    queryFn: async () => {
      const [created, signed] = await Promise.all([
        viewCall<Shop[]>(FACTORY_CONTRACT_ID, "shops_of", { account_id: accountId }),
        viewCall<Shop[]>(FACTORY_CONTRACT_ID, "shops_signed_by", { account_id: accountId }),
      ]);
      const byId = new Map([...created, ...signed].map((s) => [s.treasury, s]));
      return [...byId.values()].sort((a, b) => b.created_at_ms - a.created_at_ms);
    },
    enabled: !!FACTORY_CONTRACT_ID && !!accountId,
    refetchInterval: 15_000,
  });
}

export function useShop(treasury: string | null) {
  return useQuery<Shop | null>({
    queryKey: ["shop", treasury],
    queryFn: () => viewCall<Shop | null>(FACTORY_CONTRACT_ID, "get_shop", { treasury }),
    enabled: !!FACTORY_CONTRACT_ID && !!treasury,
    refetchInterval: (q) => (q.state.data?.status === "Active" ? false : 2_000),
  });
}

export function validShopName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$/.test(name);
}

export function shopAccount(name: string): string {
  return `${name}.${FACTORY_CONTRACT_ID}`;
}

export async function createShop(p: {
  name: string;
  displayName: string;
  signers: string[];
  threshold: number;
  depositNear: number;
  payoutAccount: string | null;
}): Promise<unknown> {
  const deposit = (BigInt(Math.round(p.depositNear * 1000)) * ONE_NEAR) / 1000n;
  return callContractOn(
    FACTORY_CONTRACT_ID,
    "create_treasury",
    {
      name: p.name,
      signers: p.signers,
      threshold: p.threshold,
      display_name: p.displayName,
      payout_account: p.payoutAccount,
    },
    deposit.toString(),
    CREATE_GAS,
  );
}

/** A mainnet account checkout can pay: a named `.near` account or a 64-hex implicit one. */
export function validPayoutAccount(id: string): boolean {
  if (/^[0-9a-f]{64}$/.test(id)) return true;
  return /^(([a-z\d]+[-_])*[a-z\d]+\.)+near$/.test(id) && id.length <= 64;
}

/** Creator only (enforced by the factory). */
export async function setPayoutAccount(treasury: string, payoutAccount: string | null): Promise<unknown> {
  return callContractOn(FACTORY_CONTRACT_ID, "set_payout_account", {
    treasury,
    payout_account: payoutAccount,
  });
}

/** Shareable checkout link for a shop. */
export function checkoutLink(treasury: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/checkout/order?shop=${encodeURIComponent(treasury)}`;
}

// ---- starting configuration ------------------------------------------------------

export interface SetupPreset {
  /** Stable token the treasury holds and the autonomy lane may pay in. */
  token: string;
  decimals: number;
  maxPerPayout: number;
  dailyCap: number;
  vetoMinutes: number;
  reserveFloor: number;
  maxTotalAllocated: number;
  vendors: string[];
}

export const PRESETS: Record<string, Omit<SetupPreset, "token" | "decimals" | "vendors"> & { label: string; blurb: string }> = {
  careful: { label: "Careful", blurb: "25 per bill, 50 a day, 30-minute veto", maxPerPayout: 25, dailyCap: 50, vetoMinutes: 30, reserveFloor: 100, maxTotalAllocated: 0 },
  standard: { label: "Standard", blurb: "50 per bill, 100 a day, 5-minute veto", maxPerPayout: 50, dailyCap: 100, vetoMinutes: 5, reserveFloor: 100, maxTotalAllocated: 0 },
  busy: { label: "Busy shop", blurb: "200 per bill, 500 a day, 15-minute veto", maxPerPayout: 200, dailyCap: 500, vetoMinutes: 15, reserveFloor: 500, maxTotalAllocated: 0 },
};

function units(n: number, decimals: number): string {
  return (BigInt(Math.round(n * 1e6)) * 10n ** BigInt(decimals) / 1_000_000n).toString();
}

/** The governance kinds a new shop needs, in the order the contract accepts them. The model
 * key is copied from the demo treasury, where signers registered it after checking its
 * hardware attestation (the hosted agent signs with it). */
export async function setupKinds(p: SetupPreset): Promise<object[]> {
  const kinds: object[] = [
    {
      SetPolicy: {
        stable_token: p.token,
        max_total_allocated: units(p.maxTotalAllocated, p.decimals),
        reserve_floor: units(p.reserveFloor, p.decimals),
      },
    },
  ];
  if (DEFAULT_TREASURY_ID) {
    const signers = await viewCall<[string, string][]>(DEFAULT_TREASURY_ID, "list_model_signers").catch(() => []);
    for (const [address, model] of signers) kinds.push({ SetModelSigner: { address, model } });
  }
  for (const v of p.vendors) kinds.push({ SetVendor: { account_id: v, enabled: true } });
  kinds.push({
    SetAutonomy: {
      policy: {
        token: p.token,
        max_per_payout: units(p.maxPerPayout, p.decimals),
        daily_cap: units(p.dailyCap, p.decimals),
        veto_window_ms: p.vetoMinutes * 60_000,
        invoices_only: true,
      },
    },
  });
  return kinds;
}

/**
 * One transaction: propose each setup change and approve it. On a brand-new treasury the
 * proposal ids are known (the next id is the current count), so the approvals can be batched.
 * With threshold 1 everything executes now; otherwise co-signers approve on the Treasury page.
 */
export async function applySetup(treasury: string, kinds: object[]): Promise<string> {
  const existing = await viewCall<unknown[]>(treasury, "list_proposals", { from: 0, limit: 100 });
  let next = existing.length;
  const actions = kinds.flatMap((kind) => {
    const id = next++;
    return [
      actionCreators.functionCall("propose", { kind, rationale: "Starting configuration (onboarding)" }, SETUP_GAS_EACH, 0n),
      actionCreators.functionCall("approve", { id }, SETUP_GAS_EACH, 0n),
    ];
  });
  return sendActions(treasury, actions);
}
