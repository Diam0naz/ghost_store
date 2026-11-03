"use client";
// Customer-facing checkout. Accepts an order reference from the URL, lets the
// customer pick any payment token, shows a live NEAR Intents quote, then on Pay:
// wet quote → deposit tx → deposit/submit → poll status to a terminal state.
//
// Supported payment origins:
// - NEAR wallet: native NEAR (auto-wrapped to wNEAR) and NEP-141 via ft_transfer
// - EVM wallet (wagmi/injected): native ETH / MATIC / BNB and ERC-20s
//
// NEAR Intents is mainnet-only and requires a refund address per origin chain,
// so quotes only run once the matching wallet is connected.

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { erc20Abi } from "viem";
import {
  useAccount,
  useConnect,
  useSendTransaction,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { mainnet, arbitrum, base, polygon, bsc, type Chain } from "wagmi/chains";
import { actionCreators } from "@near-js/transactions";
import WalletButton from "@/components/WalletButton";
import CheckoutModal, { type CheckoutStep } from "@/components/CheckoutModal";
import {
  useIntentsTokens,
  useDryQuote,
  useExecuteSwap,
  useSwapStatus,
  TERMINAL_STATUSES,
  friendlyIntentsError,
  type IntentsToken,
  type SwapStatus,
  type QuoteParams,
  type StatusResponse,
} from "@/lib/intents";
import {
  getAccountId,
  subscribeAccountId,
  sendActions,
  TREASURY_CONTRACT_ID,
  NETWORK,
} from "@/lib/near";

const JWT = process.env.NEXT_PUBLIC_INTENTS_JWT;

// Destination: USDC on NEAR. Credit the merchant's treasury account so the
// settled funds sit where the treasury contract can spend them.
const DESTINATION_ASSET =
  process.env.NEXT_PUBLIC_INTENTS_DESTINATION_ASSET ??
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const RECIPIENT =
  process.env.NEXT_PUBLIC_INTENTS_RECIPIENT ?? TREASURY_CONTRACT_ID;
const RECIPIENT_TYPE =
  process.env.NEXT_PUBLIC_INTENTS_RECIPIENT_TYPE ?? "DESTINATION_CHAIN";

// Asset we quote for native NEAR payments (funds are wrapped before deposit).
const NEAR_WRAPPED_ASSET_ID = "nep141:wrap.near";
const NEAR_NATIVE_OPTION: IntentsToken = {
  assetId: NEAR_WRAPPED_ASSET_ID,
  symbol: "NEAR",
  decimals: 24,
  blockchain: "near",
};

const EVM_CHAINS: Record<string, Chain> = {
  ethereum: mainnet,
  arbitrum,
  base,
  polygon,
  bsc,
};

const CHAIN_LABELS: Record<string, string> = {
  near: "NEAR",
  ethereum: "Ethereum",
  arbitrum: "Arbitrum",
  base: "Base",
  polygon: "Polygon",
  bsc: "BNB Chain",
  solana: "Solana",
  ton: "TON",
  tron: "Tron",
  stellar: "Stellar",
};

const STATUS_TEXT: Record<SwapStatus, string> = {
  PENDING_DEPOSIT: "Waiting for your transfer to arrive…",
  KNOWN_DEPOSIT_TX: "Transfer seen — confirming…",
  PROCESSING: "Converting to USDC…",
  SUCCESS: "Payment complete — USDC received.",
  FAILED: "The swap failed. Your deposit is refunded to your wallet.",
  REFUNDED: "Payment refunded to your wallet.",
  INCOMPLETE_DEPOSIT: "Less arrived than quoted — contact the merchant.",
};

/**
 * Convert a user-entered amount ("12.5") to smallest units without going
 * through a float — 1 NEAR is 1e24 base units, far past double precision.
 */
function toRawAmount(input: string, decimals: number): string {
  const trimmed = input.trim();
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    return "0";
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const frac = fraction.slice(0, decimals).padEnd(decimals, "0");
  const raw = `${whole || "0"}${frac}`.replace(/^0+(?=\d)/, "");
  return raw === "" ? "0" : raw;
}

/** Format smallest units as a human amount with trailing zeros trimmed. */
function formatUnits(raw: string | undefined, decimals: number, maxFrac = 6): string {
  if (raw === undefined || raw === "") return "—";
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    return "—";
  }
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const rest = value % base;
  if (rest === 0n) return whole.toString();
  const fraction = rest
    .toString()
    .padStart(decimals, "0")
    .slice(0, maxFrac)
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function formatDuration(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "—";
  if (seconds < 90) return `~${Math.round(seconds)} sec`;
  return `~${Math.round(seconds / 60)} min`;
}

function formatAccount(account: string): string {
  if (!account) return "—";
  // EVM addresses are unreadable in full; NEAR accounts stay readable as-is.
  if (account.startsWith("0x") && account.length > 20) {
    return `${account.slice(0, 6)}…${account.slice(-4)}`;
  }
  return account;
}

function tokenLabel(token: IntentsToken): string {
  const chain = CHAIN_LABELS[token.blockchain] ?? token.blockchain;
  if (token.assetId === NEAR_WRAPPED_ASSET_ID && token.symbol === "NEAR") {
    return "NEAR (native)";
  }
  return `${token.symbol} on ${chain}`;
}

export default function CheckoutPage() {
  const params = useParams<{ id: string }>();
  const reference = typeof params?.id === "string" ? params.id : "demo";
  const evmAccount = useAccount();

  const tokensQ = useIntentsTokens(JWT);
  const [nearAccountId, setNearAccountId] = useState<string | null>(null);

  // Follow the NEAR wallet so the quote has a refund address.
  useEffect(() => {
    let unsub: (() => void) | undefined;
    getAccountId()
      .then(setNearAccountId)
      .catch(() => setNearAccountId(null));
    subscribeAccountId(setNearAccountId)
      .then((u) => (unsub = u))
      .catch(() => {});
    return () => unsub?.();
  }, []);

  // Payment options: native NEAR first, then popular mainnet tokens, deduped.
  const payTokens = useMemo(() => {
    const list = tokensQ.data ?? [];
    const supported = list.filter(
      (t) => t.blockchain === "near" || Object.keys(EVM_CHAINS).includes(t.blockchain)
    );
    const popularSymbols = ["USDC", "USDT", "ETH", "DAI", "WBTC", "SOL"];
    const popular = supported.filter((t) =>
      popularSymbols.includes(t.symbol.toUpperCase())
    );
    const seen = new Set<string>();
    return [NEAR_NATIVE_OPTION, ...popular]
      .filter((t) => (seen.has(t.assetId) ? false : seen.add(t.assetId)))
      .slice(0, 13);
  }, [tokensQ.data]);

  const destinationToken = useMemo(
    () => (tokensQ.data ?? []).find((t) => t.assetId === DESTINATION_ASSET),
    [tokensQ.data]
  );
  const destSymbol = destinationToken?.symbol ?? "USDC";
  const destDecimals = destinationToken?.decimals ?? 6;

  const [token, setToken] = useState<IntentsToken>(NEAR_NATIVE_OPTION);
  const [amountInput, setAmountInput] = useState("");
  const [depositAddress, setDepositAddress] = useState<string | null>(null);

  // Debounce so typing doesn't fire a quote per keystroke.
  const [quotedAmount, setQuotedAmount] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuotedAmount(amountInput), 400);
    return () => clearTimeout(t);
  }, [amountInput]);

  const amountRaw = useMemo(
    () => toRawAmount(quotedAmount, token.decimals),
    [quotedAmount, token.decimals]
  );

  const isNearOrigin = token.blockchain === "near";
  // Refund address must match the origin chain — the API rejects empty values.
  const refundAddress = isNearOrigin
    ? nearAccountId ?? ""
    : evmAccount.address ?? "";

  // NEAR Intents only settles on mainnet. A *.testnet recipient or refund
  // address gets rejected by the quote service with a bare "Internal server
  // error", so catch it here and say something useful instead.
  const isTestnetAccount = (account: string) => account.endsWith(".testnet");
  const recipientOk = !!RECIPIENT && !isTestnetAccount(RECIPIENT);
  const refundOk = !refundAddress || !isTestnetAccount(refundAddress);

  const quoteParams = useMemo<QuoteParams | null>(() => {
    if (!recipientOk || !refundOk) return null;
    return {
      originAsset: token.assetId,
      destinationAsset: DESTINATION_ASSET,
      amount: amountRaw,
      recipient: RECIPIENT,
      refundTo: refundAddress,
      refundType: "ORIGIN_CHAIN",
      depositType: "ORIGIN_CHAIN",
      recipientType: RECIPIENT_TYPE,
      slippageTolerance: 100,
    };
  }, [token.assetId, amountRaw, refundAddress, recipientOk, refundOk]);

  const dry = useDryQuote(quoteParams, JWT);
  const status = useSwapStatus(depositAddress, JWT);
  const quote = dry.data?.quote;

  const quoteError = dry.error ? friendlyIntentsError(dry.error) : null;
  const hasAmount = amountRaw !== "0";
  const quoteReady = !!quote && !quoteError;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="mb-1 text-2xl font-extrabold tracking-tight text-primary-950">
          Checkout
        </h1>
        <p className="text-sm font-medium text-ink-600">
          Order <span className="font-mono font-bold text-primary-800">{reference}</span>{" "}
          · pay with any token, the merchant receives {destSymbol}.
        </p>
      </div>

      <div className="card space-y-4 p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-bold text-primary-950">Pay with any token</h2>
          <WalletButton />
        </div>

        {/* Token selector */}
        <label className="block">
          <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-ink-400">
            Pay with
          </span>
          <select
            className="w-full rounded-xl border border-primary-200 bg-white px-3 py-2 text-sm font-semibold text-primary-950 focus:border-primary-400 focus:outline-none"
            value={token.assetId}
            onChange={(e) => {
              const next =
                payTokens.find((t) => t.assetId === e.target.value) ??
                NEAR_NATIVE_OPTION;
              setToken(next);
              setDepositAddress(null);
            }}
          >
            {payTokens.map((t) => (
              <option key={t.assetId} value={t.assetId}>
                {tokenLabel(t)}
              </option>
            ))}
          </select>
          {tokensQ.isPending && (
            <span className="mt-1 block text-xs font-medium text-ink-400">
              Loading the token list…
            </span>
          )}
          {tokensQ.isError && (
            <span className="mt-1 block text-xs font-semibold text-red-600">
              Couldn&apos;t load the token list — showing NEAR only.
            </span>
          )}
        </label>

        {/* Amount */}
        <label className="block">
          <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-ink-400">
            Amount ({token.symbol})
          </span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            className="w-full rounded-xl border border-primary-200 bg-white px-3 py-2 text-lg font-bold text-primary-950 focus:border-primary-400 focus:outline-none"
            value={amountInput}
            onChange={(e) =>
              setAmountInput(
                e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1")
              )
            }
          />
        </label>

        {/* Quote */}
        <div className="space-y-2 rounded-xl bg-primary-50 p-4 text-sm font-medium text-ink-600">
          <div className="flex justify-between">
            <span>You pay</span>
            <span className="font-bold text-primary-950">
              {hasAmount ? `${quotedAmount} ${token.symbol}` : "—"}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Merchant receives</span>
            <span className="font-bold text-primary-950">
              {quote
                ? `≈ ${formatUnits(quote.amountOut, destDecimals)} ${destSymbol}`
                : "—"}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Guaranteed minimum</span>
            <span>
              {quote?.minAmountOut
                ? `${formatUnits(quote.minAmountOut, destDecimals)} ${destSymbol}`
                : "—"}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Estimated time</span>
            <span>{formatDuration(quote?.timeEstimate)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span>Paid to</span>
            <span
              className="truncate font-mono text-xs font-semibold text-primary-800"
              title={RECIPIENT || undefined}
            >
              {formatAccount(RECIPIENT)}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Settles as</span>
            <span>{destSymbol} on NEAR</span>
          </div>
        </div>

        {/* Quote status — always say what is happening */}
        {!hasAmount && (
          <p className="text-xs font-medium text-ink-400">
            Enter an amount to see the exact total.
          </p>
        )}
        {hasAmount && !refundAddress && (
          <p className="rounded-xl bg-primary-50 px-3 py-2 text-xs font-semibold text-ink-600">
            {isNearOrigin
              ? "Connect your NEAR wallet to see the total."
              : `Connect an ${CHAIN_LABELS[token.blockchain] ?? token.blockchain} wallet to see the total.`}
          </p>
        )}
        {hasAmount && isNearOrigin && !!refundAddress && !refundOk && (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
            Payments from NEAR need a mainnet NEAR wallet — refunds go back to the
            account you connect. Pay with an EVM token, or switch the app to
            mainnet.
          </p>
        )}
        {hasAmount && refundAddress && dry.isFetching && !quote && (
          <p className="text-xs font-medium text-ink-400">Getting the best rate…</p>
        )}
        {quoteError && (
          <div className="rounded-xl bg-red-50 px-3 py-2">
            <p className="text-xs font-semibold text-red-600">{quoteError}</p>
            <button
              onClick={() => dry.refetch()}
              className="mt-1 text-xs font-bold text-red-700 underline decoration-red-300 underline-offset-2"
            >
              Try again
            </button>
          </div>
        )}

        {!recipientOk && (
          <p className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-600">
            {RECIPIENT
              ? "This checkout can't take payments yet — the merchant's payout account is on testnet and the swap service settles on mainnet."
              : "This checkout isn't linked to a merchant payout account yet."}
          </p>
        )}

        <PaymentSection
          token={token}
          quoteParams={quoteParams}
          quoteReady={quoteReady}
          quoteBusy={dry.isFetching}
          depositAddress={depositAddress}
          setDepositAddress={setDepositAddress}
          nearAccountId={nearAccountId}
          status={status.data}
          reference={reference}
          merchant={RECIPIENT}
          receiveLabel={
            quote
              ? `≈ ${formatUnits(quote.amountOut, destDecimals)} ${destSymbol}`
              : undefined
          }
        />

        <p className="text-xs font-medium leading-relaxed text-ink-400">
          You pay from your own wallet. If the transfer can&apos;t be completed,
          the deposit is refunded to the wallet you pay from. The merchant
          receives {destSymbol} in their treasury.
        </p>
      </div>

      {/* Settlement status stays visible after the modal is dismissed */}
      {depositAddress && status.data && (
        <div className="card flex items-center justify-between p-4">
          <div className="flex items-center gap-3">
            <span className="text-2xl">
              {status.data.status === "SUCCESS"
                ? "✅"
                : STATUS_TEXT[status.data.status].startsWith("Payment refunded") ||
                  status.data.status === "FAILED" ||
                  status.data.status === "INCOMPLETE_DEPOSIT"
                ? "❌"
                : "⏳"}
            </span>
            <div>
              <p className="font-bold text-primary-950">
                {STATUS_TEXT[status.data.status]}
              </p>
              <p className="text-xs font-medium text-ink-400">
                Order <span className="font-mono">{reference}</span>
              </p>
            </div>
          </div>
          {!TERMINAL_STATUSES.includes(status.data.status) && (
            <div className="h-2 w-2 animate-ping rounded-full bg-primary-500" />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payment section — pay button, wallet requirements and the progress modal.
// Rendered as its own component so wagmi hooks stay unconditionally mounted.
// ---------------------------------------------------------------------------

function PaymentSection({
  token,
  quoteParams,
  quoteReady,
  quoteBusy,
  depositAddress,
  setDepositAddress,
  nearAccountId,
  status,
  reference,
  merchant,
  receiveLabel,
}: {
  token: IntentsToken;
  quoteParams: QuoteParams | null;
  quoteReady: boolean;
  quoteBusy: boolean;
  depositAddress: string | null;
  setDepositAddress: (addr: string | null) => void;
  nearAccountId: string | null;
  status: StatusResponse | undefined;
  reference: string;
  merchant: string;
  receiveLabel?: string;
}) {
  const isNearOrigin = token.blockchain === "near";
  const isEvmOrigin = Object.keys(EVM_CHAINS).includes(token.blockchain);
  const sendEvmDeposit = useEvmDepositSend();
  const [modalDismissed, setModalDismissed] = useState(false);

  async function sendDepositTx(
    depositAddress: string,
    amountIn: string
  ): Promise<string> {
    if (token.blockchain === "near") {
      if (!nearAccountId) throw new Error("Connect your NEAR wallet first");
      const ONE_YOCTO = "1";
      const FT_TRANSFER_GAS = "50000000000000"; // 50 Tgas
      const ftTransfer = actionCreators.functionCall(
        "ft_transfer",
        { receiver_id: depositAddress, amount: amountIn },
        BigInt(FT_TRANSFER_GAS),
        BigInt(ONE_YOCTO)
      );
      // Native NEAR must be wrapped to wNEAR before transfer (one tx, two actions).
      if (token.assetId === NEAR_WRAPPED_ASSET_ID && token.symbol === "NEAR") {
        return sendActions("wrap.near", [
          actionCreators.functionCall(
            "near_deposit",
            {},
            BigInt("30000000000000"), // 30 Tgas
            BigInt(amountIn)
          ),
          ftTransfer,
        ]);
      }
      return sendActions(token.assetId.split("nep141:")[1], [ftTransfer]);
    }

    if (isEvmOrigin) {
      return sendEvmDeposit(token, depositAddress, amountIn);
    }

    throw new Error(`Unsupported origin chain: ${token.blockchain}`);
  }

  const exec = useExecuteSwap(sendDepositTx, JWT);

  const swapStatus = status?.status;
  const terminal =
    !!swapStatus && TERMINAL_STATUSES.includes(swapStatus);
  const succeeded = swapStatus === "SUCCESS";
  const failed =
    exec.isError ||
    swapStatus === "FAILED" ||
    swapStatus === "REFUNDED" ||
    swapStatus === "INCOMPLETE_DEPOSIT";

  const modalOpen =
    !modalDismissed && (exec.isPending || exec.isSuccess || exec.isError || !!depositAddress);

  const steps: CheckoutStep[] = [
    {
      label: "Confirm the payment in your wallet",
      state: failed
        ? "error"
        : exec.isPending || (!depositAddress && !exec.isSuccess)
        ? "active"
        : "done",
    },
    {
      label: "Your transfer arrives",
      state: failed
        ? "todo"
        : succeeded || swapStatus === "PROCESSING" || swapStatus === "KNOWN_DEPOSIT_TX"
        ? "done"
        : depositAddress
        ? "active"
        : "todo",
    },
    {
      label: `Converted to USDC for the merchant`,
      state: failed
        ? "todo"
        : succeeded
        ? "done"
        : swapStatus === "PROCESSING" || swapStatus === "KNOWN_DEPOSIT_TX"
        ? "active"
        : "todo",
    },
  ];

  const modalTitle = failed
    ? "Payment didn't complete"
    : succeeded
    ? "Payment complete"
    : exec.isPending
    ? "Confirm in your wallet"
    : "Waiting for your payment";

  const modalDescription = failed
    ? "Nothing was lost — a failed transfer is refunded to the wallet you paid from."
    : succeeded
    ? "The merchant received your payment. You can close this window."
    : exec.isPending
    ? "Approve the payment request in your wallet app to continue."
    : "This usually takes under a minute.";

  const modalError = exec.isError
    ? friendlyIntentsError(exec.error)
    : swapStatus === "FAILED" || swapStatus === "REFUNDED"
    ? STATUS_TEXT[swapStatus]
    : null;

  const txHash = exec.data?.txHash ?? null;
  const txUrl = txHash ? explorerTxUrl(token, txHash) : null;

  return (
    <>
      <NEARRequirements enabled={isNearOrigin} nearAccountId={nearAccountId} />
      <EvmRequirements enabled={isEvmOrigin} token={token} />

      <button
        disabled={
          !quoteParams ||
          !quoteReady ||
          quoteBusy ||
          exec.isPending ||
          (isNearOrigin && !nearAccountId)
        }
        onClick={() => {
          if (!quoteParams) return;
          setModalDismissed(false);
          setDepositAddress(null); // reset so the modal opens from the start
          exec.mutate(
            {
              ...quoteParams,
              nearSender: isNearOrigin ? nearAccountId ?? undefined : undefined,
            },
            {
              onSuccess: ({ depositAddress: addr }) => setDepositAddress(addr),
            }
          );
        }}
        className="btn-primary w-full"
      >
        {exec.isPending
          ? "Confirm in your wallet…"
          : quoteBusy
          ? "Getting rate…"
          : "Pay now"}
      </button>

      <CheckoutModal
        open={modalOpen}
        title={modalTitle}
        description={modalDescription}
        steps={steps}
        error={modalError}
        summary={
          <div className="space-y-1">
            {receiveLabel && (
              <div>
                Merchant receives{" "}
                <strong className="text-primary-800">{receiveLabel}</strong>
              </div>
            )}
            <div>
              Paid to{" "}
              <span className="font-mono font-semibold text-primary-800">
                {formatAccount(merchant)}
              </span>
            </div>
            {depositAddress && (
              <div>
                Payment address{" "}
                <span className="font-mono font-semibold text-primary-800">
                  {formatAccount(depositAddress)}
                </span>
              </div>
            )}
          </div>
        }
        reference={reference}
        txUrl={txUrl}
        canClose={terminal || exec.isError}
        onClose={() => setModalDismissed(true)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// NEAR requirements banner
// ---------------------------------------------------------------------------

function NEARRequirements({
  enabled,
  nearAccountId,
}: {
  enabled: boolean;
  nearAccountId: string | null;
}) {
  if (!enabled || nearAccountId) return null;
  return (
    <p className="rounded-xl bg-red-50 px-4 py-2 text-xs font-semibold text-red-600">
      This token is paid from a NEAR wallet — connect one with “Connect Wallet”
      above.
    </p>
  );
}

// ---------------------------------------------------------------------------
// EVM requirements: connect injected wallet + chain switch
// ---------------------------------------------------------------------------

function EvmRequirements({
  enabled,
  token,
}: {
  enabled: boolean;
  token: IntentsToken;
}) {
  const { address, isConnected, chainId } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { switchChainAsync } = useSwitchChain();

  if (!enabled) return null;
  const chain = EVM_CHAINS[token.blockchain];
  if (!chain) {
    return (
      <p className="rounded-xl bg-red-50 px-4 py-2 text-xs font-semibold text-red-600">
        Payments from {CHAIN_LABELS[token.blockchain] ?? token.blockchain} aren&apos;t
        supported yet.
      </p>
    );
  }
  const wrongChain = isConnected && chainId !== chain.id;

  return (
    <div className="rounded-xl bg-primary-50 px-4 py-3 text-xs font-medium text-ink-600">
      {!isConnected ? (
        <div className="flex items-center justify-between gap-3">
          <span>{token.symbol} is paid from an EVM wallet.</span>
          <button
            onClick={() =>
              connectAsync({ connector: connectors[0] }).catch(console.error)
            }
            className="btn-ghost shrink-0 text-xs"
          >
            Connect EVM wallet
          </button>
        </div>
      ) : wrongChain ? (
        <div className="flex items-center justify-between gap-3">
          <span>
            Switch to {chain.name} to pay with {token.symbol}.
          </span>
          <button
            onClick={() => switchChainAsync({ chainId: chain.id }).catch(console.error)}
            className="btn-ghost shrink-0 text-xs"
          >
            Switch to {chain.name}
          </button>
        </div>
      ) : (
        <span>
          ✅ {address?.slice(0, 6)}…{address?.slice(-4)} on {chain.name}
        </span>
      )}
    </div>
  );
}

/** Explorer link for a deposit transaction on the origin chain. */
function explorerTxUrl(token: IntentsToken, hash: string): string {
  if (token.blockchain === "near") {
    return `https://explorer.${NETWORK === "mainnet" ? "" : "testnet."}near.org/transactions/${hash}`;
  }
  const base = EVM_CHAINS[token.blockchain]?.blockExplorers?.default.url;
  return base ? `${base}/tx/${hash}` : "";
}

/** Sends the EVM deposit tx (native send or ERC-20 transfer). Returns the hash. */
function useEvmDepositSend(): (
  token: IntentsToken,
  depositAddress: string,
  amountIn: string
) => Promise<string> {
  const { sendTransactionAsync } = useSendTransaction();
  const { writeContractAsync } = useWriteContract();

  return async (token, depositAddress, amountIn) => {
    if (!token.contractAddress) {
      // Native token (ETH / MATIC / BNB): plain value transfer.
      const hash = await sendTransactionAsync({
        to: depositAddress as `0x${string}`,
        value: BigInt(amountIn),
        chainId: EVM_CHAINS[token.blockchain]?.id,
      });
      return hash;
    }
    // ERC-20: transfer amountIn to the deposit address.
    const hash = await writeContractAsync({
      address: token.contractAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: "transfer",
      args: [depositAddress as `0x${string}`, BigInt(amountIn)],
      chainId: EVM_CHAINS[token.blockchain]?.id,
    });
    return hash;
  };
}
