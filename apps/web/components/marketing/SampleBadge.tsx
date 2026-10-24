import { APP_ENV, SAMPLE_CONTENT } from '../../content/marketing';

/**
 * Sample data guard (CSN-010).
 *
 * The marketing page still reads invented SAMPLE_* data until CSN-043 wires live data. That data may
 * only reach a visitor with the "Sample data" badge next to it, and the badge is hidden in
 * production. So a production build with sample content on the page must fail: nothing invented may
 * ship unlabelled. `assertSampleContentLabelled` is called while the page renders, which for this
 * static page happens at build time.
 */
export function isProductionEnv(env: string = APP_ENV): boolean {
  return env === 'production';
}

export function shouldShowSampleBadge(env: string = APP_ENV): boolean {
  return !isProductionEnv(env);
}

export function assertSampleContentLabelled(
  opts: { hasSampleContent?: boolean; env?: string } = {},
): void {
  const hasSample = opts.hasSampleContent ?? SAMPLE_CONTENT;
  const badgeShown = shouldShowSampleBadge(opts.env ?? APP_ENV);
  if (hasSample && !badgeShown) {
    throw new Error(
      'CSN-010 sample-data guard: the marketing page renders SAMPLE content but the "Sample data" ' +
        'badge is hidden in production (NEXT_PUBLIC_APP_ENV=production). Wire live data (CSN-043) ' +
        'before building for production.',
    );
  }
}

export function SampleBadge() {
  if (!shouldShowSampleBadge()) return null;
  return (
    <aside className="sample-badge" aria-label="Sample data notice">
      Sample data
    </aside>
  );
}
