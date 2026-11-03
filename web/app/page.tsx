import Link from "next/link";

export default function Home() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">Ghost Store</h1>
        <p className="text-gray-400 max-w-xl">
          Confidential AI-powered merchant treasury on NEAR. Pay vendors in any token,
          settle stablecoins, and let the AI draft M-of-N spending proposals in a TEE.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link href="/checkout/demo" className="block rounded-xl border border-gray-800 bg-gray-900 p-6 hover:border-gray-600 transition-colors">
          <div className="text-lg font-semibold text-white mb-1">Checkout</div>
          <p className="text-sm text-gray-400">Pay with any token via NEAR Intents. Settles to treasury as stablecoin.</p>
        </Link>
        <Link href="/treasury" className="block rounded-xl border border-gray-800 bg-gray-900 p-6 hover:border-gray-600 transition-colors">
          <div className="text-lg font-semibold text-white mb-1">Treasury</div>
          <p className="text-sm text-gray-400">Review and approve AI-drafted proposals. M-of-N signer flow.</p>
        </Link>
        <Link href="/flows" className="block rounded-xl border border-gray-800 bg-gray-900 p-6 hover:border-gray-600 transition-colors">
          <div className="text-lg font-semibold text-white mb-1">Flows</div>
          <p className="text-sm text-gray-400">Track where payments came in and where funds currently sit.</p>
        </Link>
      </div>
    </div>
  );
}
