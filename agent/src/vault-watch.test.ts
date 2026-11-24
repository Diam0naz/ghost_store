// Drives the cold vault watch against a simulated vault: run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Account } from "near-api-js";
import { dueInstallments, resetVaultWatch, vaultPass } from "./vault-watch.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 24);

function fakeVault() {
  const state = {
    status: {
      token: "usdt.testnet",
      destination: "acme.ghoststore.testnet",
      guardians: ["alice.testnet", "bob.testnet"],
      threshold: 2,
      frozen: false,
      held: "1000",
      available: "1000",
      limits: { weekly_cap: "300" },
    },
    requests: [] as Record<string, unknown>[],
    changes: [] as Record<string, unknown>[],
    releases: [] as number[],
    failRelease: false,
  };
  const viewer = {
    viewFunction: async ({ methodName }: { methodName: string }) => {
      if (methodName === "get_status") return state.status;
      if (methodName === "list_requests") return state.requests;
      if (methodName === "list_changes") return state.changes;
      throw new Error(methodName);
    },
  } as unknown as Account;
  const releaser = {
    functionCall: async ({ args }: { args: { id: number } }) => {
      if (state.failRelease) throw new Error("weekly release cap reached");
      state.releases.push(args.id);
      const r = state.requests.find((x) => x.id === args.id)!;
      r.installments_paid = (r.installments_paid as number) + 1;
      return { transaction: { hash: "tx" + state.releases.length } };
    },
  } as unknown as Account;
  return { state, viewer, releaser };
}

function request(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    amount: "200",
    paid: "0",
    installments_paid: 0,
    installments: 4,
    installment_interval_ms: DAY,
    note: "payroll",
    first_release_at_ms: T0 + DAY,
    status: "Pending",
    cancelled_by: null,
    ...extra,
  };
}

test("alerts, pays due installments, and reports failures once", async () => {
  resetVaultWatch();
  const { state, viewer, releaser } = fakeVault();
  const alerts: string[] = [];
  let now = T0;
  const run = () =>
    vaultPass({
      viewer,
      releaser,
      vaultId: "vault.acme.testnet",
      alert: async (t) => void alerts.push(t),
      amount: async (_t, raw) => `${raw} USDT`,
      link: "https://app/vault",
      now: () => now,
    });

  await run();
  assert.equal(alerts.length, 0, "quiet vault, no alerts");

  // A new request: one alert with the cancel/freeze prompt, nothing released yet.
  state.requests.push(request(0));
  await run();
  await run();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /release request #0 for 200 USDT \("payroll"\)/);
  assert.match(alerts[0], /cancel it or freeze/);
  assert.match(alerts[0], /https:\/\/app\/vault/);
  assert.deepEqual(state.releases, []);

  // First installment due: released once, not twice in the same interval.
  now = T0 + DAY;
  await run();
  await run();
  assert.deepEqual(state.releases, [0]);
  assert.match(alerts.at(-1)!, /released installment 1\/4 of request #0/);

  // A failing release alerts once, then retries quietly.
  now = T0 + 2 * DAY;
  state.failRelease = true;
  const before = alerts.length;
  await run();
  await run();
  assert.equal(alerts.length, before + 1);
  assert.match(alerts.at(-1)!, /NOT released.*\n.*weekly release cap/);
  state.failRelease = false;
  await run();
  assert.deepEqual(state.releases, [0, 0], "retried once the cause cleared");

  // Freeze: alert, and no releases while frozen.
  now = T0 + 3 * DAY;
  state.status.frozen = true;
  await run();
  assert.match(alerts.at(-1)!, /FROZEN/);
  assert.deepEqual(state.releases, [0, 0]);
  state.status.frozen = false;
  await run();
  assert.ok(alerts.some((a) => /unfrozen/.test(a)));

  // A rule change: alert when proposed and again when its delay starts.
  state.changes.push({ id: 0, kind: { SetDestination: { account_id: "eve.testnet" } }, approvals: ["alice.testnet"], executable_after_ms: null, status: "Pending" });
  await run();
  assert.match(alerts.at(-1)!, /change #0 proposed: send releases to eve.testnet instead\. Approvals 1\/2/);
  (state.changes[0] as Record<string, unknown>).approvals = ["alice.testnet", "bob.testnet"];
  (state.changes[0] as Record<string, unknown>).executable_after_ms = T0 + 10 * DAY;
  await run();
  assert.match(alerts.at(-1)!, /takes effect after 2026-12-04T00:00:00Z unless a guardian cancels/);
  const n = alerts.length;
  await run();
  assert.equal(alerts.length, n, "no repeats");

  // Cancellation is reported.
  state.requests[0].status = "Cancelled";
  state.requests[0].cancelled_by = "bob.testnet";
  await run();
  assert.match(alerts.at(-1)!, /request #0 \(200 USDT\) was cancelled by bob.testnet/);
});

test("without a release key it only alerts", async () => {
  resetVaultWatch();
  const { state, viewer } = fakeVault();
  state.requests.push(request(0, { first_release_at_ms: T0 }));
  const alerts: string[] = [];
  await vaultPass({ viewer, releaser: null, vaultId: "v", alert: async (t) => void alerts.push(t), amount: async (_t, r) => r, now: () => T0 });
  assert.equal(alerts.length, 1);
  assert.deepEqual(state.releases, []);
});

test("installment schedule", () => {
  const r = request(0) as Parameters<typeof dueInstallments>[0];
  assert.equal(dueInstallments(r, T0), 0);
  assert.equal(dueInstallments(r, T0 + DAY), 1);
  assert.equal(dueInstallments(r, T0 + 2 * DAY - 1), 1);
  assert.equal(dueInstallments(r, T0 + 2 * DAY), 2);
  assert.equal(dueInstallments(r, T0 + 30 * DAY), 4);
});
