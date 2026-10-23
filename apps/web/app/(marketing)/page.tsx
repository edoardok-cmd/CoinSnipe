import { Faq } from '../../components/marketing/Faq';
import { Finale } from '../../components/marketing/Finale';
import { Hero } from '../../components/marketing/Hero';
import { Pillars } from '../../components/marketing/Pillars';
import { Pricing } from '../../components/marketing/Pricing';
import { assertSampleContentLabelled } from '../../components/marketing/SampleBadge';
import { SignalFlow } from '../../components/marketing/SignalFlow';
import { Story } from '../../components/marketing/Story';

export default function MarketingPage() {
  // Fails the production build while the page still renders SAMPLE content (see SampleBadge.tsx).
  assertSampleContentLabelled();
  return (
    <main id="top">
      <Hero />
      <Pillars />
      <SignalFlow />
      <Story />
      <Pricing />
      <Faq />
      <Finale />
    </main>
  );
}
