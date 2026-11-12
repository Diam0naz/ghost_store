import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hide the dev-only "N" indicator (and its issue badge) so screen recordings stay clean.
  // Real compile/runtime errors still show; production builds never show it.
  devIndicators: false,
};

export default nextConfig;
