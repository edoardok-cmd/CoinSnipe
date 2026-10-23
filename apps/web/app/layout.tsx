import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { siteConfig } from '../lib/site';

export const metadata: Metadata = {
  title: siteConfig.name,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
