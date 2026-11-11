"use client";
// Error state: a plain-language message, a Retry action and collapsible
// technical details. `friendlyError` maps contract, wallet and RPC errors to
// sentences a merchant can act on; it is shared by every page and dialog.

import Icon from "@/components/Icon";

export function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/Failed to fetch|networkerror|NetworkError|when all errors are/i.test(raw)) {
    return "Can't reach the NEAR network right now. Check your connection and try again.";
  }
  // Wallet and network conditions.
  if (/user (rejected|cancel|denied)|rejected by user|User closed|cancelled|canceled/i.test(raw)) {
    return "You cancelled the request in your wallet. Nothing was sent.";
  }
  if (/timeout|timed out|ETIMEDOUT|UND_ERR_CONNECT/i.test(raw)) {
    return "The NEAR RPC took too long to answer. Try again in a moment.";
  }
  if (/429|Too Many Requests|rate limit/i.test(raw)) {
    return "The NEAR RPC is rate-limiting requests. Wait a few seconds and retry.";
  }
  if (/Exceeded the prepaid gas|GasExceeded|exceeded the maximum amount of gas/i.test(raw)) {
    return "The transaction ran out of gas. Retry; the app attaches enough gas for normal approvals.";
  }
  if (/NotEnoughBalance|not enough balance|LackBalanceForState/i.test(raw)) {
    return "Your wallet doesn't hold enough NEAR to pay for this transaction.";
  }
  if (/mainnet account|testnet account|wrong network|network mismatch/i.test(raw)) {
    return "Your wallet is on a different NEAR network than this treasury.";
  }
  if (/no wallet|not signed in|Wallet not connected|No account/i.test(raw)) {
    return "Connect a NEAR wallet first.";
  }
  // Invoices and invoice sales.
  if (/attach 0.01 NEAR to submit an invoice/i.test(raw)) {
    return "Submitting an invoice needs a 0.01 NEAR storage deposit.";
  }
  if (/reference must be 1-64 bytes/i.test(raw)) {
    return "Give the invoice a reference of up to 64 characters.";
  }
  if (/no such invoice|token not found/i.test(raw)) {
    return "That invoice doesn't exist on this treasury.";
  }
  if (/invoice is not open|only open invoices can be transferred/i.test(raw)) {
    return "That invoice is already paid or cancelled.";
  }
  if (/proposal to pay this invoice is (already )?pending/i.test(raw)) {
    return "A payment for this invoice is already proposed. Approve or reject that one first.";
  }
  if (/only the holder can/i.test(raw)) {
    return "Only the current holder of this invoice can do that.";
  }
  if (/only the issuer, while holding it, can cancel/i.test(raw)) {
    return "Only the issuer can cancel, and only while it still holds the invoice.";
  }
  if (/invoice is not for sale/i.test(raw)) {
    return "That invoice is no longer for sale.";
  }
  if (/payment is below the asking price/i.test(raw)) {
    return "The payment is below the asking price. Refresh to see the current price.";
  }
  if (/pay with the invoice token/i.test(raw)) {
    return "Pay with the token the invoice is denominated in.";
  }
  if (/you already hold this invoice/i.test(raw)) {
    return "You already hold this invoice.";
  }
  if (/The account .* is not registered|not registered/i.test(raw)) {
    return "Your account isn't registered with that token yet. Register it (storage_deposit) or receive some of the token first.";
  }
  if (/exceeds the account balance|The account doesn't have enough balance/i.test(raw)) {
    return "You don't hold enough of that token.";
  }
  if (/nothing to claim/i.test(raw)) {
    return "There is nothing for you to claim.";
  }
  if (/factoring fee is capped|nonzero fee needs a recipient/i.test(raw)) {
    return "The invoice sale fee must be at most 10% and needs a recipient.";
  }
  // v2: attested proposals and the autonomy lane.
  if (/veto window has not ended/i.test(raw)) {
    return "The veto window is still open. Signers can still stop this payout; try again after the countdown.";
  }
  if (/autonomy is paused/i.test(raw)) {
    return "The treasury is paused, so autonomous payouts are stopped. Signers can still approve it manually.";
  }
  if (/not in the autonomy lane/i.test(raw)) {
    return "This proposal isn't an autonomous payout; it needs signer approval.";
  }
  if (/not from a model key registered/i.test(raw)) {
    return "The AI's TEE key isn't registered on this treasury. Signers must approve a SetModelSigner proposal first.";
  }
  if (/response already used/i.test(raw)) {
    return "That AI response was already turned into proposals. Each signed response can be used once.";
  }
  if (/response is too old|response is from the future/i.test(raw)) {
    return "The AI response is too old (or its clock is off). Run the agent again for a fresh one.";
  }
  if (/attested proposals may only be/i.test(raw)) {
    return "The AI may only propose payouts, allocations and withdrawals. Governance changes need a signer.";
  }
  if (/veto window must be/i.test(raw)) {
    return "The veto window must be at least 1 minute and shorter than 7 days.";
  }
  if (/max_per_payout/i.test(raw)) {
    return "The per-payout limit must be positive and no larger than the daily cap.";
  }
  if (/address must be 0x/i.test(raw)) {
    return "Enter the TEE signing address as 0x followed by 40 lowercase hex characters.";
  }
  if (/Contract method is not found|MethodNotFound|MethodResolveError/i.test(raw)) {
    return "This treasury runs an older contract version without that feature. Upgrade it to v2 (see docs/CONTRACT.md).";
  }
  // Contract `require` messages. These come through the wallet as
  // "Smart contract panicked: …" / "GuestPanic: …", so match them before the
  // generic panic fallback below.
  if (/only a signer can do this/i.test(raw)) {
    return "Only treasury signers can do that — connect a signer account.";
  }
  if (/only the proposer or a signer can propose/i.test(raw)) {
    return "Your account isn't allowed to create proposals on this treasury.";
  }
  if (/proposal has expired/i.test(raw)) {
    return "That proposal has expired — it can no longer be approved.";
  }
  if (/proposal is not pending/i.test(raw)) {
    return "That proposal already has a final status.";
  }
  if (/already approved/i.test(raw)) {
    return "You have already approved that proposal.";
  }
  if (/allocations are paused/i.test(raw)) {
    return "Allocations are paused right now. Unpausing needs an approved SetPaused proposal.";
  }
  if (/venue is not whitelisted/i.test(raw)) {
    return "That venue isn't whitelisted — propose a venue cap for it first.";
  }
  if (/venue refused|venue rejected|venue-refused/i.test(raw)) {
    return "The venue refused the allocation. Nothing was supplied and the recorded principal was rolled back.";
  }
  if (/venue paid nothing|withdraw for proposal .* failed|withdraw .* failed/i.test(raw)) {
    return "The venue refused or paid nothing for the withdrawal. Your recorded principal is unchanged.";
  }
  if (/ft_transfer_call failed|ft_transfer failed|token transfer failed/i.test(raw)) {
    return "The token transfer failed — check the token contract, recipient and treasury balance.";
  }
  if (/could not read (token )?balance/i.test(raw)) {
    return "Couldn't read the token balance, so the allocation was rolled back. Try again.";
  }
  if (/only the policy stable token can be allocated/i.test(raw)) {
    return "Only the policy's stable token can be allocated to a venue.";
  }
  if (/reserve floor would be breached|below the reserve floor/i.test(raw)) {
    return "The allocation would leave the treasury below its reserve floor.";
  }
  if (/amount exceeds the venue cap/i.test(raw)) {
    return "The amount would push this venue past its cumulative cap.";
  }
  if (/amount exceeds the total allocation limit/i.test(raw)) {
    return "The amount would exceed the policy's total allocation limit.";
  }
  if (/proposal has not expired yet/i.test(raw)) {
    return "That proposal is still inside its 7-day window — no need to expire it yet.";
  }
  if (/amount must be positive/i.test(raw)) {
    return "Enter a positive amount.";
  }
  if (/policy not configured/i.test(raw)) {
    return "The yield policy isn't configured yet — propose SetPolicy first.";
  }
  if (/insufficient balance after storage reserve/i.test(raw)) {
    return "The treasury doesn't hold enough free NEAR for that payout.";
  }
  if (/no such proposal/i.test(raw)) {
    return "That proposal no longer exists.";
  }
  if (/rationale too long/i.test(raw)) {
    return "The rationale is too long — keep it under 500 characters.";
  }
  if (/no position at this venue/i.test(raw)) {
    return "That venue holds no principal — there is nothing to withdraw.";
  }
  if (/GuestPanic|deserialize|wasm execution|Smart contract panicked/i.test(raw)) {
    return "The treasury contract rejected that request. It may need to be updated or redeployed.";
  }
  if (/account .* has not been found|does not exist while viewing/i.test(raw)) {
    return "The treasury contract doesn't exist at the configured address. Check NEXT_PUBLIC_TREASURY_CONTRACT_ID.";
  }
  if (/unsupported scheme|no such method|MethodNotFound/i.test(raw)) {
    return "The treasury contract is missing a method — it may need redeployment.";
  }
  return "Something went wrong while talking to the treasury.";
}

function cleanDetail(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/\n+/g, " ").trim().slice(0, 220);
}

export default function ErrorState({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="card px-8 py-12 text-center">
      <span className="mx-auto inline-flex h-11 w-11 items-center justify-center rounded-xl bg-red-50 text-red-600 ring-1 ring-red-100">
        <Icon name="alert" className="h-5 w-5" />
      </span>

      <h3 className="mt-4 font-semibold text-ink-900">
        {friendlyError(error)}
      </h3>

      {onRetry && (
        <button
          onClick={onRetry}
          disabled={retrying}
          className="btn-ghost mt-4 text-sm"
        >
          {retrying ? "Retrying…" : "Try again"}
        </button>
      )}

      <details className="mt-4 text-left">
        <summary className="cursor-pointer text-center text-xs font-semibold text-ink-400 hover:text-primary-700">
          Technical details
        </summary>
        <code className="mt-2 block break-words rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-600">
          {cleanDetail(error)}
        </code>
      </details>
    </div>
  );
}
