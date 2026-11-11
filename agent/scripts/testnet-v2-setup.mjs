// Upgrade the testnet treasury to v2 (attested proposals + autonomy lane) and configure it.
// Signs with the keys in ~/.near-credentials/testnet. Testnet only. Run each step from agent/:
//
//   node scripts/testnet-v2-setup.mjs deploy-fresh    # ALTERNATIVE to fund+upgrade when the vault's
//                                                     #   key is lost: create TREASURY_CONTRACT_ID
//                                                     #   (a sub-account of treasury-dev.testnet,
//                                                     #   funded with 5.2 NEAR), deploy, init, and
//                                                     #   copy the v1 policy and venue cap
//   node scripts/testnet-v2-setup.mjs fund            # 0.55 NEAR from each signer to the vault
//   node scripts/testnet-v2-setup.mjs upgrade         # deploy v2 wasm + migrate (one tx, atomic)
//   node scripts/testnet-v2-setup.mjs proposer-key    # new FC key: propose, propose_attested,
//                                                     #   execute_auto; writes it to ../.env
//   node scripts/testnet-v2-setup.mjs vendors         # create + storage-register the 3 demo vendors
//   node scripts/testnet-v2-setup.mjs governance <tee-address>
//                                                     # propose + 2-of-2 approve: SetModelSigner,
//                                                     #   SetVendor x2, SetAutonomy (invoices only),
//                                                     #   SetFactoringFee (0.5% to treasury-dev)
//   node scripts/testnet-v2-setup.mjs fee             # only SetFactoringFee (if governance stopped early)
//   node scripts/testnet-v2-setup.mjs move-funds      # 2-of-2 payout of the old vault's USDT
//                                                     #   to TREASURY_CONTRACT_ID
//   node scripts/testnet-v2-setup.mjs fake-invoice    # only the unmatched FM-0099 invoice
//   node scripts/testnet-v2-setup.mjs cancel-invoice 4  # issuer withdraws an open invoice
//   node scripts/testnet-v2-setup.mjs vote reject 9   # approve/reject as a signer
//                                                     #   (default treasury-dev.testnet)
//   node scripts/testnet-v2-setup.mjs invoices        # vendor agents submit 3 matching invoices
//                                                     #   and 1 that matches no bill
//
// Build the wasm first (repo root):
//   RUSTFLAGS="-C link-arg=-s -C target-cpu=mvp" cargo build \
//     --manifest-path contracts/treasury/Cargo.toml --target wasm32-unknown-unknown --release
// Get <tee-address> from `npm run register-model` (it verifies the TDX quote first).
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const require = createRequire(resolve(here, "../package.json"));
const { connect, keyStores, KeyPair, transactions, utils } = require("near-api-js");
// TREASURY_CONTRACT_ID and NEAR_RPC_URL can live in ../.env; exported shell values take precedence.
require("dotenv").config({ path: resolve(ROOT, ".env"), quiet: true });

// Point every step at another treasury (e.g. one made by `deploy-fresh`) with TREASURY_CONTRACT_ID.
const VAULT = process.env.TREASURY_CONTRACT_ID ?? "vault.treasury-dev.testnet";
const SIGNERS = ["treasury-dev.testnet", "cosigner.treasury-dev.testnet"];
const PROPOSER = "ai-proposer.treasury-dev.testnet";
const STABLE = "usdt.fakes.testnet";
// Recurring vendors go on the autonomy allowlist; the new supplier does not.
const VENDORS = ["packaging.treasury-dev.testnet", "courier.treasury-dev.testnet"];
const NEW_SUPPLIER = "fabric-mill.treasury-dev.testnet";
const MODEL = process.env.NEAR_AI_MODEL_FOR_SETUP ?? "Qwen/Qwen3.6-35B-A3B-FP8";
const USDT = (n) => String(BigInt(n) * 1_000_000n);
const NEAR = (n) => BigInt(utils.format.parseNearAmount(n));
const TGAS = (n) => BigInt(n) * 1_000_000_000_000n;

const keyStore = new keyStores.UnencryptedFileSystemKeyStore(`${homedir()}/.near-credentials`);
// rpc.testnet.near.org is deprecated (it answers 429). Override with NEAR_RPC_URL if needed.
const nodeUrl = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const near = await connect({ networkId: "testnet", keyStore, nodeUrl });
const account = (id) => near.account(id);
const [step, arg] = process.argv.slice(2);

function returned(outcome) {
  const v = outcome.status?.SuccessValue;
  if (v === undefined) throw new Error(`call failed: ${JSON.stringify(outcome.status)}`);
  return v ? JSON.parse(Buffer.from(v, "base64").toString()) : null;
}

async function passProposal(kind, rationale, contractId = VAULT) {
  const [first, second] = await Promise.all(SIGNERS.map(account));
  const id = returned(
    await first.functionCall({ contractId, methodName: "propose", args: { kind, rationale }, gas: TGAS(30) })
  );
  for (const s of [first, second]) {
    await s.functionCall({ contractId, methodName: "approve", args: { id }, gas: TGAS(150) });
  }
  const p = await first.viewFunction({ contractId, methodName: "get_proposal", args: { id } });
  console.log(`#${id} ${Object.keys(kind)[0]}: ${p.status}`);
}

switch (step) {
  case "fund": {
    for (const id of SIGNERS) {
      const o = await (await account(id)).sendMoney(VAULT, NEAR("0.55"));
      console.log(`${id} -> ${VAULT}: ${o.transaction.hash}`);
    }
    break;
  }
  case "deploy-fresh": {
    if (VAULT === "vault.treasury-dev.testnet" || !VAULT.endsWith(`.${SIGNERS[0]}`)) {
      throw new Error(`Set TREASURY_CONTRACT_ID to a new sub-account of ${SIGNERS[0]}, e.g. vault2.${SIGNERS[0]}`);
    }
    const code = readFileSync(
      resolve(ROOT, "contracts/treasury/target/wasm32-unknown-unknown/release/treasury.wasm")
    );
    const kp = KeyPair.fromRandom("ed25519");
    await keyStore.setKey("testnet", VAULT, kp);
    const funder = await account(SIGNERS[0]);
    const o = await funder.signAndSendTransaction({
      receiverId: VAULT,
      actions: [
        transactions.createAccount(),
        transactions.transfer(NEAR("5.2")),
        transactions.addKey(kp.getPublicKey(), transactions.fullAccessKey()),
        transactions.deployContract(code),
        transactions.functionCall(
          "new",
          { signers: SIGNERS, threshold: 2, proposer: PROPOSER },
          TGAS(30),
          0n
        ),
      ],
    });
    returned(o);
    console.log(`created ${VAULT}, deployed ${code.length} bytes, initialised: ${o.transaction.hash}`);
    console.log(`key saved to ~/.near-credentials/testnet/${VAULT}.json`);
    await (await account(SIGNERS[0])).functionCall({
      contractId: STABLE,
      methodName: "storage_deposit",
      args: { account_id: VAULT, registration_only: true },
      gas: TGAS(30),
      attachedDeposit: NEAR("0.00125"),
    });
    await passProposal(
      { SetPolicy: { stable_token: STABLE, max_total_allocated: USDT(1000), reserve_floor: USDT(100) } },
      "Same yield policy as the v1 vault."
    );
    await passProposal(
      { SetVenueCap: { venue: "ghoststore-venue.testnet", cap: USDT(500) } },
      "Same venue cap as the v1 vault."
    );
    console.log(`Next: fund it with USDT (a 2-of-2 Payout from the old vault works), set`);
    console.log(`TREASURY_CONTRACT_ID=${VAULT} in .env and NEXT_PUBLIC_TREASURY_CONTRACT_ID in web/.env.local.`);
    break;
  }
  case "upgrade": {
    const code = readFileSync(
      resolve(ROOT, "contracts/treasury/target/wasm32-unknown-unknown/release/treasury.wasm")
    );
    const o = await (await account(VAULT)).signAndSendTransaction({
      receiverId: VAULT,
      actions: [transactions.deployContract(code), transactions.functionCall("migrate", {}, TGAS(150), 0n)],
    });
    returned(o);
    console.log(`deployed ${code.length} bytes + migrated: ${o.transaction.hash}`);
    break;
  }
  case "proposer-key": {
    const kp = KeyPair.fromRandom("ed25519");
    const o = await (await account(PROPOSER)).addKey(
      kp.getPublicKey().toString(),
      VAULT,
      ["propose", "propose_attested", "execute_auto"],
      NEAR("0.25")
    );
    console.log(`added function-call key ${kp.getPublicKey()}: ${o.transaction.hash}`);
    const envPath = resolve(ROOT, ".env");
    const env = readFileSync(envPath, "utf8");
    if (!/^PROPOSER_PRIVATE_KEY=.*$/m.test(env)) throw new Error("PROPOSER_PRIVATE_KEY not found in .env");
    writeFileSync(envPath, env.replace(/^PROPOSER_PRIVATE_KEY=.*$/m, `PROPOSER_PRIVATE_KEY=${kp.toString()}`));
    console.log(".env PROPOSER_PRIVATE_KEY updated. The previous key stays valid on chain.");
    break;
  }
  case "vendors": {
    const funder = await account(SIGNERS[0]);
    for (const v of [...VENDORS, NEW_SUPPLIER]) {
      const kp = KeyPair.fromRandom("ed25519");
      await keyStore.setKey("testnet", v, kp);
      await funder.createAccount(v, kp.getPublicKey(), NEAR("0.05"));
      await funder.functionCall({
        contractId: STABLE,
        methodName: "storage_deposit",
        args: { account_id: v, registration_only: true },
        gas: TGAS(30),
        attachedDeposit: NEAR("0.00125"),
      });
      console.log(`created ${v} and registered it on ${STABLE}`);
    }
    break;
  }
  case "governance": {
    const address = (arg ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error("usage: governance <0x tee signing address>");
    await passProposal(
      { SetModelSigner: { address, model: MODEL } },
      `Trust ${MODEL} TEE key ${address}; TDX quote and key binding checked with npm run register-model.`
    );
    for (const v of VENDORS) {
      await passProposal({ SetVendor: { account_id: v, enabled: true } }, `Recurring vendor ${v}.`);
    }
    await passProposal(
      {
        SetAutonomy: {
          policy: {
            token: STABLE,
            max_per_payout: USDT(50),
            daily_cap: USDT(100),
            veto_window_ms: 5 * 60_000,
            invoices_only: true,
          },
        },
      },
      "AI may pay invoices from allowlisted vendors up to 50 USDT each, 100 USDT/day, after a 5 minute veto window."
    );
    await passProposal(
      { SetFactoringFee: { fee_bps: 50, recipient: SIGNERS[0] } },
      "0.5% fee on invoice sales, paid to the operator account."
    );
    break;
  }
  case "move-funds": {
    // 2-of-2 payout of the old v1 vault's whole USDT balance to the new treasury.
    const OLD = "vault.treasury-dev.testnet";
    if (VAULT === OLD) throw new Error("Set TREASURY_CONTRACT_ID to the new treasury first");
    const signer = await account(SIGNERS[0]);
    const balance = await signer.viewFunction({ contractId: STABLE, methodName: "ft_balance_of", args: { account_id: OLD } });
    if (BigInt(balance) === 0n) throw new Error(`${OLD} holds no ${STABLE}`);
    await passProposal(
      { Payout: { to: VAULT, token: STABLE, amount: balance } },
      `Move all ${STABLE} to the v2 treasury ${VAULT}.`,
      OLD
    );
    const now = await signer.viewFunction({ contractId: STABLE, methodName: "ft_balance_of", args: { account_id: VAULT } });
    console.log(`${VAULT} now holds ${now} base units of ${STABLE}`);
    break;
  }
  case "fake-invoice": {
    // Only the invoice that matches no bill (for when `invoices` stopped before it).
    // Top the supplier up first: deposit + prepaid gas is ~0.041 NEAR.
    const supplier = await account(NEW_SUPPLIER);
    const existing = (await supplier.viewFunction({ contractId: VAULT, methodName: "list_invoices", args: {} }))
      .filter((i) => i.issuer === NEW_SUPPLIER && i.reference === "FM-0099" && i.status === "Open");
    if (existing.length) {
      console.log(`FM-0099 is already open as invoice #${existing.map((i) => i.id).join(", #")}; nothing to do.`);
      if (existing.length > 1) console.log(`Cancel the extras with: cancel-invoice ${existing.slice(1).map((i) => i.id).join(" / ")}`);
      break;
    }
    const { available } = await supplier.getAccountBalance();
    if (BigInt(available) < NEAR("0.06")) {
      await (await account(SIGNERS[0])).sendMoney(NEW_SUPPLIER, NEAR("0.05"));
      console.log(`topped up ${NEW_SUPPLIER} with 0.05 NEAR`);
    }
    const id = returned(
      await (await account(NEW_SUPPLIER)).functionCall({
        contractId: VAULT,
        methodName: "submit_invoice",
        args: { token: STABLE, amount: USDT(45), due_ms: Date.now() + 86_400_000, reference: "FM-0099", document_hash: null },
        gas: TGAS(30),
        attachedDeposit: NEAR("0.01"),
      })
    );
    console.log(`invoice #${id}: FM-0099 from ${NEW_SUPPLIER} (matches no bill; the AI must not pay it)`);
    break;
  }
  case "cancel-invoice": {
    // The issuer withdraws an open invoice it still holds (burns the NFT).
    const idArg = process.argv[3];
    if (!/^[0-9]+$/.test(idArg ?? "")) throw new Error("usage: cancel-invoice <invoice id>");
    const inv = await (await account(SIGNERS[0])).viewFunction({ contractId: VAULT, methodName: "get_invoice", args: { invoice_id: Number(idArg) } });
    if (!inv) throw new Error(`invoice #${idArg} does not exist`);
    returned(
      await (await account(inv.issuer)).functionCall({
        contractId: VAULT, methodName: "cancel_invoice", args: { invoice_id: Number(idArg) }, gas: TGAS(30),
      })
    );
    console.log(`invoice #${idArg} (${inv.reference}) cancelled by ${inv.issuer}`);
    break;
  }
  case "vote": {
    // node scripts/testnet-v2-setup.mjs vote <approve|reject> <proposal id> [signer]
    const [, action, idArg, who] = process.argv.slice(2);
    if (!["approve", "reject"].includes(action) || !/^[0-9]+$/.test(idArg ?? "")) {
      throw new Error("usage: vote <approve|reject> <proposal id> [signer account]");
    }
    const signerId = who ?? SIGNERS[0];
    const o = await (await account(signerId)).functionCall({
      contractId: VAULT,
      methodName: action,
      args: { id: Number(idArg) },
      gas: TGAS(action === "approve" ? 150 : 30),
    });
    returned(o);
    const p = await (await account(signerId)).viewFunction({
      contractId: VAULT,
      methodName: "get_proposal",
      args: { id: Number(idArg) },
    });
    console.log(`${signerId} ${action}d #${idArg}: now ${p.status} (${p.approvals.length} approval(s)) tx ${o.transaction.hash}`);
    break;
  }
  case "fee": {
    // Just the last governance step, for when `governance` stopped before it.
    await passProposal(
      { SetFactoringFee: { fee_bps: 50, recipient: SIGNERS[0] } },
      "0.5% fee on invoice sales, paid to the operator account."
    );
    break;
  }
  case "invoices": {
    // Each vendor (or its agent) submits invoices with its own key, created by the `vendors` step.
    const due = (days) => Date.now() + days * 86_400_000;
    const submissions = [
      [VENDORS[0], USDT(40), due(2), "PKG-2291"],
      [VENDORS[1], USDT(25), due(5), "CR-7781"],
      [NEW_SUPPLIER, USDT(120), due(4), "FM-0042"],
      // Matches no bill in the books: the AI should leave it unpaid.
      [NEW_SUPPLIER, USDT(45), due(1), "FM-0099"],
    ];
    for (const [vendor, amount, due_ms, reference] of submissions) {
      const id = returned(
        await (await account(vendor)).functionCall({
          contractId: VAULT,
          methodName: "submit_invoice",
          args: { token: STABLE, amount, due_ms, reference, document_hash: null },
          gas: TGAS(30),
          attachedDeposit: NEAR("0.01"),
        })
      );
      console.log(`invoice #${id}: ${reference} from ${vendor}`);
    }
    break;
  }
  default:
    console.error("steps: deploy-fresh | fund | upgrade | proposer-key | vendors | governance <tee-address> | fee | move-funds | invoices | fake-invoice | cancel-invoice <id> | vote <approve|reject> <id> [signer]");
    process.exit(2);
}
