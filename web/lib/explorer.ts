// Block explorer links (NearBlocks) for the configured network.
import { NETWORK } from "@/lib/near";

const BASE = NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";

export const explorerAccountUrl = (accountId: string) => `${BASE}/address/${accountId}`;
export const explorerTxUrl = (hash: string) => `${BASE}/txns/${hash}`;
