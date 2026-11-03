// Flows page. Shows incoming payments (checkout settlements) and outgoing
// payments (executed proposals). Reads on-chain events from the treasury contract.

interface FlowRow {
  id: string;
  type: "in" | "out";
  description: string;
  token: string;
  amount: string;
  ts: number;
}

// Stub until indexed events are available
const STUB_FLOWS: FlowRow[] = [
  {
    id: "0",
    type: "in",
    description: "Checkout settlement via NEAR Intents",
    token: "USDC",
    amount: "120.00",
    ts: Date.now() - 3600_000,
  },
  {
    id: "1",
    type: "out",
    description: "Payout → vendor.near (proposal #0 executed)",
    token: "NEAR",
    amount: "5.0000",
    ts: Date.now() - 1800_000,
  },
];

export default function FlowsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Flows</h1>
        <p className="text-gray-400 text-sm">Incoming payments and outgoing treasury actions</p>
      </div>

      {/* TODO: replace with real on-chain event log */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase tracking-wider">
              <th className="px-4 py-3 text-left">Type</th>
              <th className="px-4 py-3 text-left">Description</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3 text-right">Token</th>
              <th className="px-4 py-3 text-right">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {STUB_FLOWS.map((f) => (
              <tr key={f.id} className="hover:bg-gray-800/40 transition-colors">
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    f.type === "in"
                      ? "bg-green-900/50 text-green-300"
                      : "bg-violet-900/50 text-violet-300"
                  }`}>
                    {f.type === "in" ? "IN" : "OUT"}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-300">{f.description}</td>
                <td className="px-4 py-3 text-right font-mono text-white">{f.amount}</td>
                <td className="px-4 py-3 text-right text-gray-400">{f.token}</td>
                <td className="px-4 py-3 text-right text-gray-500 text-xs">
                  {new Date(f.ts).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-600">
        On-chain event indexing coming soon. Payouts and settlements will appear here automatically.
      </p>
    </div>
  );
}
