import type { Metadata } from 'next';
import { DM_Sans, Urbanist } from 'next/font/google';
import type { ReactNode } from 'react';
import { siteMeta } from '../../content/marketing';
import { Footer } from '../../components/marketing/Footer';
import { Nav } from '../../components/marketing/Nav';
import { SampleBadge } from '../../components/marketing/SampleBadge';

/* Brand type: Urbanist 700-800 for titles, DM Sans for body. Exposed as CSS variables that
   packages/ui/src/tokens.css reads. */
const urbanist = Urbanist({
  subsets: ['latin'],
  weight: ['500', '600', '700', '800'],
  variable: '--font-urbanist',
  display: 'swap',
});
const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-dm-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  icons: { icon: '/brand/logogram.svg' },
  title: siteMeta.title,
  description: siteMeta.description,
};

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`cs ${urbanist.variable} ${dmSans.variable}`}>
      <a href="#top" className="skip">
        Skip to content
      </a>
      <Nav />
      {children}
      <Footer />
      <SampleBadge />
    </div>
  );
}
