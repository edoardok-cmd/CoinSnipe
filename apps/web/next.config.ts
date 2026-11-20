import type { NextConfig } from 'next';
import { securityHeaders } from './lib/security-headers';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Linting runs as its own CI step (`pnpm lint`), not inside `next build`.
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders(process.env.NODE_ENV !== 'production') }];
  },
};

export default nextConfig;
