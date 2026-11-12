// Picking the right EVM wallet. Several extensions (HOT, Rabby, Coinbase, ...) inject
// window.ethereum, so "the injected wallet" is whichever one won that race. EIP-6963 lets
// each wallet announce itself with a name, an rdns id and its own icon; wagmi turns those
// announcements into connectors. We always ask for MetaMask by its rdns.
import type { Connector } from "wagmi";

export const METAMASK_RDNS = "io.metamask";
export const METAMASK_FALLBACK_ICON = "/wallets/metamask.svg";

const rdnsOf = (c: Connector): string[] =>
  c.rdns === undefined ? [] : Array.isArray(c.rdns) ? [...c.rdns] : [c.rdns as string];

/** The MetaMask connector, or null if MetaMask is not installed (or not announced yet). */
export function findMetaMask(connectors: readonly Connector[]): Connector | null {
  return (
    connectors.find((c) => c.id === METAMASK_RDNS || rdnsOf(c).includes(METAMASK_RDNS)) ??
    connectors.find((c) => c.id === "metaMask") ??
    null
  );
}

export const METAMASK_MISSING =
  "MetaMask isn't installed in this browser (another wallet such as HOT may be answering instead). Install it from metamask.io, then reload this page.";
