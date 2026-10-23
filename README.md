# CoinSnipe

CoinSnipe is an educational crypto data and signals product. It has a marketing site and a
five-tab app (Home, Market, Discover, Portfolio, Learn) that explain what the data says about each
tracked coin. It is educational only and never advisory: it describes data and never tells anyone
what to do with their money. Keep that tone in every string, comment and doc in this repo.

## Workspace map

| Path                | What it is                                                       |
| ------------------- | ---------------------------------------------------------------- |
| `apps/web`          | Next.js 15 (App Router, Tailwind 4): marketing site, app and API |
| `apps/worker`       | Node scripts for scheduled jobs, one file per job in `src/jobs/` |
| `packages/scoring`  | Scoring engine (pure TypeScript, no I/O)                         |
| `packages/data`     | Data-source adapters                                             |
| `packages/db`       | Database package (placeholder until the schema task)             |
| `packages/backtest` | Replay harness that reuses the scoring package                   |
| `packages/ui`       | Shared components and brand tokens                               |

Package names are scoped, for example `@coinsnipe/scoring`.

## Requirements

- Node 22.20 or newer 22.x (`.nvmrc` tracks the current 22.x; `engines` enforces the 22.20 floor). Node 24.12+ and 26+ also work; Node 23 and 25 do not.
- pnpm 10.28.2 (pinned in `packageManager`; enable with `corepack enable`)

## Running it

```bash
pnpm install          # install everything (CI uses --frozen-lockfile)
pnpm dev              # start the web app and watch the packages
pnpm build            # build every workspace
pnpm lint             # ESLint (typescript-eslint, flat config)
pnpm typecheck        # tsc --noEmit in every workspace
pnpm test             # Vitest unit tests in every workspace
pnpm format           # Prettier, write
pnpm format:check     # Prettier, check only
```

`lint`, `typecheck`, `test`, `build` and `dev` run through Turborepo. Copy `.env.example` to
`.env.local` and fill it in locally; never commit real values. End-to-end tests (Playwright) will
live in `apps/web/e2e`; the CI job for them is a commented stub.

## Project context

- Project hub (private planning pages): https://coinsnipe-hub-repo.vercel.app
- Specs: `.claude/specs/CoinSnipe/` in the private Agent X workspace (a path in a private
  workspace, not part of this repository).
