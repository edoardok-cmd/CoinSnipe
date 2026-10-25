# End-to-end tests (Playwright)

Specs run against a running production build (Chrome via `channel: 'chrome'`; set `E2E_CHANNEL=`
to use Playwright's own Chromium):

```
pnpm --filter @coinsnipe/web build && pnpm --filter @coinsnipe/web start -p 3555
E2E_BASE_URL=http://127.0.0.1:3555 pnpm --filter @coinsnipe/web exec playwright test -c e2e/playwright.config.ts
```

| Spec                           | What it pins                                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `marketing.spec.ts`            | CSN-010: console errors, section screenshots (`__screenshots__/`), nav spy, burger, slider, pills                                                              |
| `marketing-responsive.spec.ts` | CSN-012: at 1440/1024/390 (and 768/901/1100) no sideways scroll, no overlapping siblings or text, no cut-off text, in every page state; the mobile sticky pill |
| `marketing-a11y.spec.ts`       | CSN-012: axe on every width, measured text contrast (>= 4.5:1 on the rendered backdrops), focus rings, tab order, keyboard, reduced motion, image alt text     |

`helpers/` holds the shared in-page checks (`layout.ts`), the contrast measurement (`contrast.ts`) and
the focus-ring check (`focus.ts`). The unit-level twins of the stylesheet rules are in
`tests/a11y-css.test.ts` (Vitest, no browser).

Set `E2E_REPORT_DIR=<dir>` to also write `axe-report.json`, `contrast-report.json`,
`focus-report.json` and `screenshots/<width>/` there.

The CI job that wires this up is CSN-074 (`.github/workflows/ci.yml`, still a stub).
