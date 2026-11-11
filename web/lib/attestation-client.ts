"use client";

import { useQuery } from "@tanstack/react-query";
import type { AttestationVerification } from "@/lib/attestation";

async function fetchAttestation(
  proposalId: number
): Promise<AttestationVerification> {
  const response = await fetch(`/api/attestation/${proposalId}`, {
    cache: "no-store",
  });
  const body = (await response.json().catch(() => null)) as
    | AttestationVerification
    | { error?: string }
    | null;
  if (body && "status" in body && typeof body.status === "string") {
    return body as AttestationVerification;
  }
  throw new Error(
    body && "error" in body && body.error
      ? body.error
      : `Proof service returned HTTP ${response.status}`
  );
}

/**
 * Fetch and verify one proposal's attestation record.
 * `poll` is intended for pending proposals so a record published after the
 * proposal appears without a page reload.
 */
export function useAttestation(
  proposalId: number | null,
  enabled = true,
  poll = false
) {
  return useQuery<AttestationVerification>({
    queryKey: ["attestation", proposalId],
    queryFn: () => fetchAttestation(proposalId as number),
    enabled: enabled && proposalId !== null,
    staleTime: 60_000,
    retry: 1,
    refetchInterval: poll ? 30_000 : false,
  });
}
