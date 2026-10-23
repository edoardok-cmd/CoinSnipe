import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Linting runs as its own CI step (`pnpm lint`), not inside `next build`.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
