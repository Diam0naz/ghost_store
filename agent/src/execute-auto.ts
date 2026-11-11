// Keeper: execute autonomy-lane payouts whose veto window has ended.
// `execute_auto` is permissionless, so any account can run this; the proposer's function-call
// key needs `execute_auto` in its allowed methods.
//
//   npm run execute-auto
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

import { getEnv, nearAccount } from "./near.js";

interface Proposal {
  id: number;
  status: string;
  auto_execute_after_ms: number | null;
}

async function main(): Promise<void> {
  const contractId = getEnv("TREASURY_CONTRACT_ID");
  const account = await nearAccount();
  const due: Proposal[] = [];
  for (let from = 0; ; from += 100) {
    const page = (await account.viewFunction({
      contractId,
      methodName: "list_proposals",
      args: { from, limit: 100 },
    })) as Proposal[];
    due.push(
      ...page.filter(
        (p) => p.status === "Pending" && p.auto_execute_after_ms !== null && p.auto_execute_after_ms <= Date.now()
      )
    );
    if (page.length < 100) break;
  }
  if (due.length === 0) {
    console.log("No autonomy-lane payouts are due.");
    return;
  }
  for (const p of due) {
    const outcome = await account.functionCall({
      contractId,
      methodName: "execute_auto",
      args: { id: p.id },
      gas: 100_000_000_000_000n,
    });
    console.log(`#${p.id}: tx ${outcome.transaction.hash}`);
    for (const r of outcome.receipts_outcome) for (const l of r.outcome.logs) console.log(`  ${l}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
