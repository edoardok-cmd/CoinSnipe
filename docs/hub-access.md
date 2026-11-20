# CoinSnipe Hub access (CSN-004)

Status: **decision recorded; access change PENDING user activation.** Nothing in this document has been applied by the harness. Post-change verification has not run yet.

## Decision

| Item | Value |
|---|---|
| Decision | Hub privacy: make the internal CoinSnipe Hub private |
| Option chosen | "Private" (Vercel Deployment Protection, default option: Vercel Authentication on all deployments) |
| Decision log | D25 in the private CoinSnipe decisions log (Agent X workspace). Approved 2026-10-23 with protection as the recommended default. |
| User confirmation | 2026-10-28, "private" |
| Recorded | 2026-11-20 |
| Task | CSN-004 |

Why: the hub mirror holds internal costs and pricing. The public Vercel URL `https://coinsnipe-hub-repo.vercel.app` must not serve them anonymously.

Alternatives on the board, not chosen: password protection (needs the Vercel Pro plan); making the GitHub repo private and deleting the public deployment.

## Click-path for the user (Vercel dashboard)

We have no Vercel credentials, so the user makes this change. Labels can differ slightly between dashboard versions; confirm each step on screen.

1. Sign in at vercel.com with the account or team that owns the hub project.
2. Open the project for the hub (`coinsnipe-hub-repo`).
3. Go to **Settings**, then **Deployment Protection**.
4. Under **Vercel Authentication**, pick the option that covers **all deployments, including Production**. Do not pick a preview-only or standard option, because that leaves the production URL public. Save.
5. If the production option is greyed out or missing, stop. That usually means the plan needs an upgrade. Tell the orchestrator so the alternatives (password protection on Pro, or private GitHub repo plus deleting the public deployment) can be decided.
6. Wait a minute, then run the verification commands below. If the old 200 still appears, redeploy the production deployment and check again.

Optional, needed before the sync script can run again (see "Sync script impact"):

7. Still under **Deployment Protection**, find **Protection Bypass for Automation** and create a bypass secret for the hub project.
8. Store that secret in your local secret manager. Do not paste it into chat, into a repo file, or into a shell command.

## Verification

Anonymous checks, run with no cookies and no credentials. Use `-I` (HEAD) or the GET form as shown. A protected hub returns 401, or a 302 to a Vercel login or SSO page.

```
curl -sS -I -o /dev/null -w '%{http_code} %{redirect_url}\n' https://coinsnipe-hub-repo.vercel.app/
curl -sS -I -o /dev/null -w '%{http_code} %{redirect_url}\n' https://coinsnipe-hub-repo.vercel.app/score-lab/coinsnipe-data-and-pricing.html
```

Acceptance: neither URL returns 200 to an anonymous request.

### Baseline (captured 2026-11-20, about 17:01 UTC, before any user change)

| URL | Anonymous status | Redirect target (host and path) |
|---|---|---|
| `/` | 302 | `vercel.com/sso-api` |
| `/score-lab/coinsnipe-data-and-pricing.html` | 302 | `vercel.com/sso-api` |

Notes on the baseline:

- Neither URL returns 200 right now. The 302 goes to Vercel's SSO gate, and following it ends at `vercel.com/login` with HTTP 200. The `_vercel_sso_nonce` cookie also points to Vercel Authentication. So protection appears to be active already.
- The record does not show who enabled it or when. I could not tell from the HTTP checks whether the user made the change after 2026-10-28. Treat the baseline as "not 200 now" and nothing more.
- Post-change verification is **PENDING user activation**. The result must be re-captured and pasted here after the user saves the setting.

### Post-change (PENDING)

| URL | Status | Date |
|---|---|---|
| `/` | PENDING | PENDING |
| `/score-lab/coinsnipe-data-and-pricing.html` | PENDING | PENDING |

## GitHub repo visibility

Command: `gh repo view TJmosh/coinsnipe-hub-repo --json visibility`

Result (2026-11-20): not determined.

- `gh` is signed in as `edoardok-cmd`. The command returned `Could not resolve to a Repository` (exit 1). `gh api repos/TJmosh/coinsnipe-hub-repo` returned 404.
- Anonymous `https://github.com/TJmosh/coinsnipe-hub-repo` and `https://api.github.com/repos/TJmosh/coinsnipe-hub-repo` both returned 404.
- That fits a private repo that this account cannot see. It also fits a wrong owner or repo name. It does not prove either one.
- The user should confirm the owner and name, then check the repo's visibility in GitHub settings. Changing visibility is a separate decision and is not part of this task.

A Vercel-only change does not hide the hub source. If the GitHub repo is public, the content is still readable there.

## Sync script impact (D25 side effect)

The hub mirror is refreshed by `.claude/specs/CoinSnipe/hub/sync-hub.py`. That script lives in the Agent X harness, not in this repo, and it was not edited for CSN-004.

- Once protection is on, the script gets no hub content. Its `urllib` fetch follows the redirect and receives the Vercel login page with HTTP 200 (checked read-only on 2026-11-20).
- The script also runs `shutil.rmtree` on `hub/site/` and `hub/text/` before fetching. A run now would delete the mirror and write login-page HTML in its place.
- **Do not run `sync-hub.py` until a bypass is wired in and the script is fixed.** The fix needs a follow-up task: fail closed (abort before `rmtree` when the final URL is not the hub, or when a fetch is not 200 HTML) and send the bypass header.
- Bypass config, not yet set anywhere:
  - Secret source: Vercel project, Settings, Deployment Protection, Protection Bypass for Automation.
  - Env var name the sync script would read: `VERCEL_PROTECTION_BYPASS_SECRET` (proposed name; the value is never written to the repo).
  - Header Vercel checks on requests: `x-vercel-protection-bypass`. Confirm against Vercel's current docs when implementing.
  - Status: **not configured**.

`.env.example` is not changed. The CoinSnipe app does not read the hub, and the sync script lives in the harness, so listing the variable in this repo would mislead readers.

## Sensitive content

This file is in the public CoinSnipe repo. It holds no secret values, no internal costs, and no pricing. Keep it that way when updating it.
