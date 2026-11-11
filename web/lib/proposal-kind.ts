// ProposalKind metadata helpers for Phase 4/6 server-side validation.
// Kept separate from lib/proposals.ts so the client bundle stays lean and so we
// do not try to patch a union type with prototype hacks.
import type { ProposalKind } from "./proposals";

/** The stable token a proposal, if any, targets. */
export function proposalTokenId(kind: ProposalKind): string | null {
  if ("Payout" in kind) return kind.Payout.token ?? null;
  if ("Allocate" in kind) return kind.Allocate.token;
  return null;
}
