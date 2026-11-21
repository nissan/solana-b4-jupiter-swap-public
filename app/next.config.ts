import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev` would otherwise write its own AGENTS.md into app/; the
  // repository's agent contract is the one at the root.
  agentRules: false,
  serverExternalPackages: ["ws"],
  turbopack: {
    resolveAlias: {
      fs: { browser: "./empty-module.js" },
    },
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    }
    return config;
  },
};

export default nextConfig;
