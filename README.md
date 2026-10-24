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

## Git hooks / private docs guard

This repo is public. Some planning docs are private and must never be pushed here. A `pre-push`
hook (`scripts/git-hooks/pre-push`) refuses any push whose history contains a file named
`decisions.md` or `data-licensing.md`, in any folder.

- `pnpm install` turns the guard on for your clone (it runs `scripts/install-git-hooks.sh`). It
  copies the hook into the clone's shared git folder, so all worktrees use it, whichever branch
  is checked out.
- Check it is on: `bash scripts/install-git-hooks.sh --check` (exit 0 means active and current).
- If a push is refused: the message lists the files. Rewrite the branch to drop them, then push again.
  Do not bypass the hook.
- **No protection without the installer.** A clone that skipped `pnpm install` (or used
  `--ignore-scripts`) has no guard. Run `bash scripts/install-git-hooks.sh` before any push.
- **Re-run after changes.** The guard is a copy. After the hook file changes (pull, merge), or
  after you move or rename the clone folder, run `pnpm install` or the installer again. Until
  then git can silently skip the guard. `--check` tells you.
- If your git folder is read-only the installer warns and does not install; fix that and re-run.
- **Other hooks stop running.** Git runs hooks only from the guard's folder once it is on. In this
  clone, other hooks in `.git/hooks` (pre-commit, commit-msg, ...) and any global or system
  `core.hooksPath` hooks no longer run. The installer lists what it finds. It does not copy or
  chain them.
- **Remove the guard** (only if you must):

  ```bash
  git config --local --unset core.hooksPath
  rm -rf "$(git rev-parse --git-common-dir)/coinsnipe-hooks"
  ```

  `pnpm install` puts it back, because it runs the installer. To skip it for one install, use
  `pnpm install --ignore-scripts`. That leaves you with **no protection** until you run the
  installer again, so do not push in that state.

- Tests: `pnpm test:hooks`.

## Project context

- Project hub (private planning pages): https://coinsnipe-hub-repo.vercel.app
- Specs: `.claude/specs/CoinSnipe/` in the private Agent X workspace (a path in a private
  workspace, not part of this repository).
