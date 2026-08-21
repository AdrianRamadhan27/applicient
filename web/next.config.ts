import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Docker runtime copies a production-only pnpm dependency tree and
  // starts the app with `next start`.
};

export default nextConfig;
