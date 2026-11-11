// Run with: npm test
// Node's built-in test runner + type stripping, no test framework dependency.

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  canonicalJson,
  extractAttestationTag,
  type ProposalAttestation,
  type AttestationCheckId,
} from "./attestation.ts";
import {
  computeContentHash,
  computeRationaleTag,
  verifyProposalAttestation,
  type ProposalForVerification,
} from "./attestation-verify.ts";

const keyPair = generateKeyPairSync("ed25519");
const privateKey = keyPair.privateKey;
const publicKeyPem = keyPair.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

function proposal(overrides: Partial<ProposalForVerification> = {}): ProposalForVerification {
  const kind = {
    Payout: { to: "vendor.testnet", token: "usdt.fakes.testnet", amount: "5000000" },
  };
  const rationaleBase = "Pay the January invoice to vendor.testnet.";
  const tag = computeRationaleTag(kind, rationaleBase);
  return {
    id: 7,
    kind,
    rationale: `${rationaleBase} [att:${tag}]`,
    created_at_ms: 1_760_000_000_000,
    ...overrides,
  };
}

function recordFor(
  p: ProposalForVerification,
  opts: {
    signingKey?: KeyObject;
    publicKey?: string;
    issuedOffsetMs?: number;
  } = {}
): ProposalAttestation {
  const contentHash = computeContentHash(p.id, p.kind, p.rationale);
  const signature = sign(
    null,
    Buffer.from(contentHash, "utf8"),
    opts.signingKey ?? privateKey
  ).toString("base64");
  const tag = extractAttestationTag(p.rationale)?.tag;
  return {
    proposalId: p.id,
    contentHash,
    signature,
    agentPublicKey: opts.publicKey ?? publicKeyPem,
    teePublicKey: opts.publicKey ?? publicKeyPem,
    attestationReport: null,
    provider: "local-agent",
    measurement: "sha256:measurement-a",
    issuedAt: new Date(p.created_at_ms + (opts.issuedOffsetMs ?? 1_000)).toISOString(),
    rationaleTag: tag,
    algorithm: "ed25519",
    inference: null,
  };
}

const baseOptions = {
  expectedMeasurements: ["sha256:measurement-a"],
  issuedAtToleranceMs: 10 * 60 * 1000,
};

test("canonicalJson sorts object keys recursively", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }),
    '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}'
  );
});

test("valid record passes all content checks", () => {
  const p = proposal();
  const record = recordFor(p);
  const result = verifyProposalAttestation(p, record, {
    ...baseOptions,
    // Test-only injection: exercise aggregation. Production never passes this.
    verifyReport: () => ({ status: "pass", reason: "test verifier" }),
  });
  assert.equal(result.status, "verified");
  assert.equal(result.checks.filter((c) => c.status === "fail").length, 0);
});

test("record without a verified report is partial, never verified", () => {
  const p = proposal();
  const record = recordFor(p);
  const result = verifyProposalAttestation(p, record, baseOptions);
  assert.equal(result.status, "partial");
  assert.equal(result.checks.find((c) => c.id === "report" as AttestationCheckId)?.status, "not_performed");
  assert.notEqual(result.status, "verified");
});

test("changing the on-chain amount after signing is a mismatch", () => {
  const p = proposal();
  const record = recordFor(p);
  const tampered: ProposalForVerification = {
    ...p,
    kind: {
      Payout: { to: "vendor.testnet", token: "usdt.fakes.testnet", amount: "9000000" },
    },
  };
  const result = verifyProposalAttestation(tampered, record, {
    ...baseOptions,
    verifyReport: () => ({ status: "pass", reason: "test verifier" }),
  });
  assert.equal(result.status, "mismatch");
  assert.equal(result.checks.find((c) => c.id === "content")?.status, "fail");
});

test("changing the on-chain rationale after signing is a mismatch", () => {
  const p = proposal();
  const record = recordFor(p);
  const tampered: ProposalForVerification = {
    ...p,
    rationale: p.rationale.replace("January", "February"),
  };
  const result = verifyProposalAttestation(tampered, record, baseOptions);
  assert.equal(result.status, "mismatch");
  assert.equal(result.checks.find((c) => c.id === "content")?.status, "fail");
});

test("tampering with the on-chain tag is a mismatch", () => {
  const p = proposal();
  const record = recordFor(p);
  const tampered: ProposalForVerification = {
    ...p,
    rationale: p.rationale.replace(/\[att:[0-9a-f]{12}\]/, "[att:aaaaaaaaaaaa]"),
  };
  const result = verifyProposalAttestation(tampered, record, baseOptions);
  assert.equal(result.status, "mismatch");
  assert.equal(result.checks.find((c) => c.id === "tag")?.status, "fail");
  assert.equal(result.checks.find((c) => c.id === "content")?.status, "fail");
});

test("a signature made with a different key fails", () => {
  const p = proposal();
  const other = generateKeyPairSync("ed25519");
  const record = recordFor(p, { signingKey: other.privateKey });
  const result = verifyProposalAttestation(p, record, baseOptions);
  assert.equal(result.status, "mismatch");
  assert.equal(result.checks.find((c) => c.id === "signature")?.status, "fail");
});

test("a missing record returns none", () => {
  const result = verifyProposalAttestation(proposal(), null, baseOptions);
  assert.equal(result.status, "none");
  assert.equal(result.record, null);
});

test("a measurement outside the allow-list is a mismatch", () => {
  const p = proposal();
  const record = recordFor(p);
  const result = verifyProposalAttestation(p, record, {
    ...baseOptions,
    expectedMeasurements: ["sha256:some-other-image"],
  });
  assert.equal(result.status, "mismatch");
  assert.equal(result.checks.find((c) => c.id === "measurement")?.status, "fail");
});

test("an empty measurement allow-list is not performed and yields partial", () => {
  const p = proposal();
  const record = recordFor(p);
  const result = verifyProposalAttestation(p, record, {
    ...baseOptions,
    expectedMeasurements: [],
  });
  assert.equal(result.status, "partial");
  assert.equal(result.checks.find((c) => c.id === "measurement")?.status, "not_performed");
});

test("an issuedAt after the clock tolerance is a mismatch", () => {
  const p = proposal();
  const record = recordFor(p, { issuedOffsetMs: 11 * 60 * 1000 });
  const result = verifyProposalAttestation(p, record, baseOptions);
  assert.equal(result.status, "mismatch");
  assert.equal(result.checks.find((c) => c.id === "issued_at" as AttestationCheckId)?.status, "fail");
});
