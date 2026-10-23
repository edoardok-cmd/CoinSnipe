# CSN-010 PR notes: marketing site ported from the design canvas

Educational, never advisory. Every number rendered on the page is invented SAMPLE data until CSN-043.

## Compliance: flagged copy (needs the user's yes before either phrase ships)

Neither flagged phrase is in the code. Placeholders are neutral; tests fail if either phrase returns.

| Flagged phrase                | Where it was                                                   | Shipped placeholder           | Alternative 1                                           | Alternative 2                         |
| ----------------------------- | -------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------- | ------------------------------------- |
| "Find the coins worth buying" | Not in the canvas. Only named in the brief's compliance to-do. | none (no heading uses it)     | "See what the data says about every coin"               | "Understand any coin at a glance"     |
| "Find winners early"          | Canvas story step 2 heading                                    | "See what is quietly growing" | "See what is quietly growing" (this is the placeholder) | "Explore projects with growing usage" |

Other canvas lines that read as advice or timing predictions were reworded to descriptive wording (review round 1):

- Momentum pillar "Is it actually cheap now" -> "How has its price been moving".
- Feature card "Spot promising coins before the crowd does." -> "Explore which coins show growing activity."
- Footer tagline "Spot the signal before the crowd. ... understand before they act." -> "Signals, narratives and lessons for people who want to understand what the crypto data shows."
- FAQ 3 "whether its moment is coming ... overheated" -> "how its market season looks, whether people really use it, and how fast its price has run lately."
- Page title "... know what you hold" -> "CoinSnipe: invest in crypto and understand what you own". Page metadata now lives in `content/marketing.ts` (`siteMeta`), and tests scan it with the banned-word list.
- Still as the canvas has it: "Know what you buy." (hero headline, brief-mandated; the only place "buy" appears in copy).
- Stat "0 scams listed" is a factual claim about the data set; it is SAMPLE, but it must be real or removed at CSN-043.
- Tests now also reject cheap, promising, "before the crowd", "moment is coming", early, undervalued and bargain anywhere in the copy.

Reworded to stay inside the word rules (buy, sell, hold, target, pump, guaranteed, recommended for you):

- "Smart signals on every coin you hold" -> "... every coin you own".
- Portfolio step: "every holding" -> "every coin you own"; "when a holding turns heated" -> "when one of your coins turns heated".
- FAQ 1: "It never tells you what to buy or sell" -> "It never tells you what to do with your money".

## Canvas vs brief disagreements (canvas won unless noted)

1. Section order: canvas puts "We read the data. You get the answer." before "Everything from signal to decision"; the brief lists them the other way round. Canvas order used.
2. Coin tabs: brief says each table has "the three signals" (D01). The canvas shows one Temperature read ("Smart signal") on the coin and niche tables. Rendered as the canvas shows it. The v0.3 set (Quality, Timing, quadrant label) is not on the canvas; its quadrant label sits behind `NEXT_PUBLIC_SIGNALS_V03=1` (`signalConfig.showV03Signals`), which adds a "State" column on the coin table. If the user wants v0.3 as the default, flip the flag default in `content/marketing.ts`.
3. Nav buttons are 44px tall in the canvas (Log in, Start for free); the brand rule says one 52px size. Canvas used for the nav bar only; every other button is 52px.
4. Bento "A clearer way to invest in crypto" (brief section 7): the canvas has no markup or copy for it (only leftover CSS), and the hub page has none either. Not built; nothing was invented. Needs a canvas section before it can be ported.
5. FAQ "Questions? Straight answers": absent from the canvas body, present on the hub's live page and the export. Built from the six Q&As in the export (FAQ 1 reworded, see above). Layout is mine (native details/summary on the brand card style), placed between Pricing and the final CTA as on the hub page. Please confirm.
6. Pricing: canvas shows "$12,99/mo" (comma); the brief says $12.99/mo. Used $12.99/mo. Canvas has no trial length; added "7-day free trial" (D06, yearly only, no monthly price). Canvas heading "Start free. Upgrade when you want more." used (the export says "Unlock more with Pro").
7. Footer: canvas has four link columns (Product, Company, Resources, Legal) plus App Store and Google Play buttons; the brief lists Product, Resources, Legal. Canvas columns used. Store buttons dropped (D27: web and PWA only, native later). Company name and year stay `[COMPANY NAME], [YEAR]` (D07).
8. Logo: the canvas draws an inline crosshair mark; the brand page ships `logogram.svg`. Used the brand file (`public/brand/logogram.svg`).
9. Final CTA: canvas has two buttons (Start for free now, Take 2 min quiz). Both built. Their targets are placeholders (`#`, `#signals`) until the quiz and app routes exist.
10. Dead links: Log in, Start your free trial, Explore narratives, Browse hidden gems, See all niches and similar app routes are `#` until CSN-050 and later tasks create them.

## Sample data guard

- Sample data lives in `content/marketing.ts` as `SAMPLE_*` exports.
- `components/marketing/SampleBadge.tsx`: shows a "Sample data" badge whenever `NEXT_PUBLIC_APP_ENV` is not `production`.
- `app/(marketing)/page.tsx` calls `assertSampleContentLabelled()` while rendering. With `NEXT_PUBLIC_APP_ENV=production` and sample content present the build fails (verified, see evidence). It passes again once the page stops rendering sample content (CSN-043 sets `hasSampleContent` to false).
- Deploy config must set `NEXT_PUBLIC_APP_ENV` (`production` only on the real production deploy). The name is not yet in `.env.example` (outside this task's file list): add `NEXT_PUBLIC_APP_ENV=` and `NEXT_PUBLIC_SIGNALS_V03=`.
- Note R-N1 (requirements): "no `SAMPLE_` fixture in production bundles" is CSN-039's check. This guard is the stricter rule for the marketing page only.

## Assets and gaps

- The canvas export's image blobs (`/_blob/...`) are not in the artifact folder, so nothing could be taken from the canvas itself. Coin logos (21), the three pillar images, the DefiLlama and CoinGecko logos and `logogram.svg` were copied from the hub mirror (`.claude/specs/CoinSnipe/hub/site/coinsnipe-site/assets`) into `apps/web/public/brand/`. They are real files, not placeholders.
- GAP, pillars: the canvas alt text describes different artwork ("a glowing glass coin orbited by a light ring", "three glass coins above a platform", "a glowing ribbon rising from small waves") than the hub files (people around a cube, an hourglass, a target). The hub brand page calls the hub files "the current set", so they are used, but the canvas may hold newer art. Confirm with the user. Images are marked decorative (`alt=""`) because each sits above its heading.
- GAP, licences: the coin logos are third-party marks, and the DefiLlama and CoinGecko files are what the hub shows, not verified downloads from the vendors' brand pages. Verify before launch (CSN-004 or the data-licensing task). The brief says both vendors publish official files.
- GAP, no `/login`, `/signup` or quiz routes exist yet (see item 10).
- Pepe has no logo in the set, so it shows a labelled square tile, as the canvas does.

## Files outside the task's file list

- `apps/web/app/globals.css`: one added `@import` of `packages/ui/src/tokens.css` so Tailwind sees the theme. No other stylesheet is allowed by the file list, so the shared marketing styles (`.cs ...`) also live in `tokens.css`.
- `apps/web/app/page.tsx`: removed (empty placeholder that collided with `(marketing)/page.tsx`).
- `apps/web/vitest.config.ts`: `oxc.jsx.runtime = 'automatic'` so tests can render `.tsx` components (tsconfig keeps `jsx: preserve` for Next).
- `apps/web/components/marketing/{ui,Nav,Hero,CoinTabs,SignalFlow,Pillars,Story,Pricing,Faq,Finale,Footer,SampleBadge}.tsx`, tests under `apps/web/tests`, e2e under `apps/web/e2e`, assets under `apps/web/public/brand`.

## Lighthouse (mobile, production build, `next start`)

Raw JSON and a score summary are saved in `apps/web/e2e/lighthouse/`. See `summary.json`.

## Not changed on purpose

- Motion from the canvas that depends on scroll-driven CSS timelines (blur-reveal headings, box rise) was not ported; the page keeps simple fades, the auto-slider, the count-up, the pinned story card and the rotating niches card, all of which stop under `prefers-reduced-motion`.
- Hero 3D window mock from an older canvas revision is not on the current canvas and was not built.
