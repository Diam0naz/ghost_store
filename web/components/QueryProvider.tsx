"use client";
// Provides TanStack Query and Wagmi context to the whole app.
// Wagmi is used in checkout only (EVM wallet connection for multi-chain deposits).
// NEAR wallet uses near-api-js directly (see lib/near.ts).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http } from "wagmi";
import { mainnet, arbitrum, base, polygon, bsc } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { useState } from "react";

const wagmiConfig = createConfig({
  chains: [mainnet, arbitrum, base, polygon, bsc],
  connectors: [injected()],
  transports: {
    [mainnet.id]: http(),
    [arbitrum.id]: http(),
    [base.id]: http(),
    [polygon.id]: http(),
    [bsc.id]: http(),
  },
});

export default function QueryProvider({ children }: { children: React.ReactNode }) {
  // useState so the QueryClient is stable per render tree (Next.js RSC safe)
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { refetchOnWindowFocus: false, retry: 1 },
        },
      })
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
