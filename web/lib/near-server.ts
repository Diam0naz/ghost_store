// Server-side NEAR view calls for API routes. Kept separate from lib/near.ts so
// server code does not pull in wallet-selector or React hooks.

const NETWORK =
  process.env.NEAR_NETWORK ??
  process.env.NEXT_PUBLIC_NEAR_NETWORK ??
  "testnet";

const RPC_URL =
  process.env.NEAR_RPC_URL ??
  process.env.NEXT_PUBLIC_NEAR_RPC_URL ??
  (NETWORK === "mainnet"
    ? "https://rpc.mainnet.fastnear.com"
    : "https://rpc.testnet.fastnear.com");

export const SERVER_TREASURY_CONTRACT_ID =
  process.env.TREASURY_CONTRACT_ID ??
  process.env.NEXT_PUBLIC_TREASURY_CONTRACT_ID ??
  "";

function assertTestnetNetwork(): void {
  if (NETWORK !== "testnet") {
    throw new Error(
      `Ghost Store is testnet-only. Found NEAR_NETWORK="${NETWORK}". Do not use mainnet here.`
    );
  }
  if (!RPC_URL.includes("rpc.testnet.near.org") && !RPC_URL.includes("testnet") && !RPC_URL.includes("127.0.0.1")) {
    throw new Error(
      `Ghost Store only talks to testnet RPC. Found RPC_URL="${RPC_URL}". Rejecting anything that looks like mainnet.`
    );
  }
}

export function assertTestnetAccountId(accountId: string): void {
  if (!accountId.endsWith(".testnet")) {
    throw new Error(
      `Ghost Store only accepts testnet accounts. Refusing account "${accountId}" — it does not end in ".testnet".`
    );
  }
}

function argsToBase64(args: object): string {
  return Buffer.from(JSON.stringify(args), "utf8").toString("base64");
}

/** JSON-RPC `call_function` at optimistic finality. Throws on RPC errors. */
export async function viewCallServer<T>(
  contractId: string,
  methodName: string,
  args: object = {}
): Promise<T> {
  assertTestnetNetwork();
  if (!contractId) throw new Error("No treasury contract id is configured");
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "attestation-verify",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "optimistic",
        account_id: contractId,
        method_name: methodName,
        args_base64: argsToBase64(args),
      },
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`NEAR RPC returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    error?: { message?: string };
    result?: { result?: number[] };
  };
  if (body.error) {
    throw new Error(body.error.message || "NEAR RPC error");
  }
  const bytes = body.result?.result;
  if (!Array.isArray(bytes)) {
    throw new Error("NEAR RPC response did not include a result");
  }
  return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as T;
}
