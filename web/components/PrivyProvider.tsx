"use client";
// Privy auth provider. Wraps the app so pages can gate on Privy login.
//
// If NEXT_PUBLIC_PRIVY_APP_ID is not configured the wrapper renders children
// unchanged and usePrivyAuth() reports privyAvailable: false — callers then
// fall back to NEAR wallet-selector auth (see components/LoginGate.tsx).

import { PrivyProvider } from "@privy-io/react-auth";

export default function PrivyProviderWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  if (!appId) return <>{children}</>;

  return (
    <PrivyProvider
      appId={appId}
      config={{
        appearance: {
          theme: "light",
          accentColor: "#7a2ff0",
        },
        // Create an Ethereum embedded wallet for users who sign in but have no
        // wallet — gives every merchant a payment identity out of the box.
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
