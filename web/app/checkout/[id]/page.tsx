// Customer-facing checkout page. Accepts a payment ID, shows a NEAR Intents
// quote for any-token-to-USDC settlement into the treasury, and confirms payment.
// Intents is mainnet-only; quotes run with dry:true locally.

interface Props {
  params: Promise<{ id: string }>;
}

export default async function CheckoutPage({ params }: Props) {
  const { id } = await params;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Checkout</h1>
        <p className="text-gray-400 text-sm">Payment ref: <code className="text-gray-200">{id}</code></p>
      </div>

      {/* Quote card */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 space-y-4">
        <h2 className="font-semibold text-white">Pay with any token</h2>
        <div className="space-y-2 text-sm text-gray-400">
          <div className="flex justify-between">
            <span>You send</span>
            <span className="text-white font-medium">— NEAR</span>
          </div>
          <div className="flex justify-between">
            <span>Treasury receives</span>
            <span className="text-white font-medium">— USDC</span>
          </div>
          <div className="flex justify-between">
            <span>Route</span>
            <span className="text-gray-300">NEAR Intents</span>
          </div>
        </div>

        {/* TODO: wire up Intents quote API (mainnet, dry:true for local dev) */}
        <button
          disabled
          className="w-full rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold text-white transition-colors"
        >
          Get Quote (coming soon)
        </button>
      </div>

      <p className="text-xs text-gray-600">
        Settlement uses NEAR Intents (mainnet only). Funds go directly to the treasury contract, not an intermediary.
      </p>
    </div>
  );
}
