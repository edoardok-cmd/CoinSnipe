import { CoinTabsSection } from '../../components/marketing/CoinTabs';
import { Faq } from '../../components/marketing/Faq';
import { Finale } from '../../components/marketing/Finale';
import { Hero } from '../../components/marketing/Hero';
import { Pillars } from '../../components/marketing/Pillars';
import { Pricing } from '../../components/marketing/Pricing';
import { assertSampleContentLabelled } from '../../components/marketing/SampleBadge';
import { SignalFlow } from '../../components/marketing/SignalFlow';
import { Story } from '../../components/marketing/Story';

/* Section order follows the hub's live marketing page (#site): hero, how, trends, gems, portfolio,
   signal to decision, spot the moves, pricing, final CTA, questions. */
export default function MarketingPage() {
  // Fails the production build while the page still renders SAMPLE content (see SampleBadge.tsx).
  assertSampleContentLabelled();
  return (
    <main id="top">
      <Hero />
      <Pillars />
      <Story />
      <SignalFlow />
      <CoinTabsSection />
      <Pricing />
      <Finale />
      <Faq />
    </main>
  );
}
