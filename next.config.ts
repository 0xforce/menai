import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      "playwright-core",
      "playwright-aws-lambda",
    ],
  },
};

export default nextConfig;
