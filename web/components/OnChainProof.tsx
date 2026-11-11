"use client";
// Proof for proposals created through `propose_attested`. Everything shown here was checked
// by the treasury contract itself when the proposal was created: it recomputed the response
// hash, recovered the TEE signer with ecrecover and required a governance-registered key.
// Nothing here depends on an off-chain service.

import type { AiAttestation } from "@/lib/proposals";
import Icon from "@/components/Icon";
import CopyButton from "@/components/CopyButton";

export function OnChainProofBadge({ attestation }: { attestation: AiAttestation }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200/70"
      title={`The contract verified a TEE signature from ${attestation.signer} (${attestation.model}) over this exact model output.`}
    >
      <Icon name="shield" className="h-3.5 w-3.5" />
      TEE-signed · checked on chain
    </span>
  );
}

export function OnChainProofDetails({ attestation }: { attestation: AiAttestation }) {
  const rows: [string, string][] = [
    ["Model", attestation.model],
    ["TEE signing key", attestation.signer],
    ["Response hash", attestation.response_hash],
    ["Private request hash", attestation.request_hash],
    ["Completed", new Date(attestation.created_s * 1000).toLocaleString()],
  ];
  return (
    <details className="rounded-lg border border-line bg-surface px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium text-ink-900">
        What the contract verified
      </summary>
      <p className="mt-2 text-ink-600">
        The model ran inside NEAR AI Cloud&apos;s TEE and signed its output. The contract
        recomputed the hash, recovered the signer and only accepted a key the signers
        registered. The merchant&apos;s books stay private: only the request hash is on chain.
        A valid signature proves which model wrote this, not that it is a good idea.
      </p>
      <dl className="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[auto,1fr]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-semibold text-ink-400">{k}</dt>
            <dd className="flex min-w-0 items-start gap-1 font-mono text-ink-900">
              <span className="min-w-0 break-all">{v}</span>
              {k !== "Completed" && k !== "Model" && <CopyButton value={v} label={`Copy ${k.toLowerCase()}`} />}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
