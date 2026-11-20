# Deploying apps/web (Vercel)

Host: Vercel (CSN-001 D04). Domain: `coinsnipe.ai` is a **default pending user confirmation** (D05). Do not point DNS until the domain is confirmed.

## One-time setup (account owner, in a terminal or the dashboard)

Never paste tokens into commands or chat. `vercel login` is interactive.

1. `pnpm dlx vercel login`
2. From the repo root: `pnpm dlx vercel link` (create project `coinsnipe-web`).
3. Dashboard > Project > Settings > General: Root Directory `apps/web`; enable "Include files outside the Root Directory"; Framework Next.js; Node 22. Install/build commands come from `apps/web/vercel.json` (pnpm + turbo).
4. Settings > Git: Production Branch `main`. Pull requests get Preview deployments.
5. Settings > Deployment Protection: Vercel Authentication ON for **Preview** deployments. Preview URLs then require a Vercel login.
6. Environment variables (Settings > Environment Variables, or `pnpm dlx vercel env add NAME production`, which prompts for the value):
   - None are required by the site today. `NEXT_PUBLIC_POSTHOG_KEY` is reserved for the future analytics task (the CSP already allows the PostHog hosts); when it is added, set it for Production only so Preview traffic does not pollute production analytics. Add other `.env.example` variables only when a task needs them.
7. Domain: Settings > Domains > add `<domain>` (primary) and `www.<domain>` set to redirect (308) to `<domain>`.

## DNS records (at the registrar, once D05 is confirmed)

- Apex `A` `76.76.21.21`
- `www` `CNAME` `cname.vercel-dns.com`

Vercel shows the exact values per project; trust the dashboard if it differs. HTTPS certificates are issued automatically and http redirects to https.

## Deploy

- Pushing `main` deploys to production. **Get explicit user opt-in before the first push.**
- Manual: `pnpm dlx vercel deploy --prod` uploads your local working tree, so run it only from a clean, up-to-date `main` checkout.

## Rollback

- Dashboard > Deployments > previous good deployment > "Promote to Production" (instant rollback), or `pnpm dlx vercel rollback`.

## Security headers

HSTS is sent with `includeSubDomains; preload`. Do **not** submit the domain to hstspreload.org until the domain is final (D05) and every subdomain serves HTTPS: preload removal is slow. The CSP still allows `script-src 'unsafe-inline'` (Next inline bootstrap), so an A+ grade may need the nonce-CSP follow-up CSN-015-FOLLOWUP-1; check the real grade after the first deploy.

Defined in `apps/web/lib/security-headers.ts` and applied via `next.config.ts` (CSP, HSTS, nosniff, Referrer-Policy, Permissions-Policy, frame-ancestors none). The PostHog host in the CSP is `eu.i.posthog.com`; change it if the project region differs. After deploy, https://securityheaders.com/?q=https://`<domain>` should grade A or better.

## Acceptance checks

- `curl -sI https://<domain>/` returns 200; `curl -sI http://<domain>/` redirects to https.
- A preview URL opened logged out shows the Vercel login.
