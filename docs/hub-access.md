# CoinSnipe Hub access (CSN-004)

Status:

- The anonymous baseline already returns 302 to the Vercel SSO gate (`vercel.com/sso-api`) at capture time (2026-11-20, about 17:11 UTC). The 17:01 UTC capture matched.
- The user's activation of the Vercel setting is **unconfirmed**. Nothing in this document has been applied by the harness, and this document does not claim the change is done.
- Post-change verification has not run yet.

## Decision

| Item | Value |
|---|---|
| Decision | Hub privacy: make the internal CoinSnipe Hub private |
| Option chosen | Vercel URL protection: Vercel Authentication on all deployments, including Production (default option on the board). The user's word was "private". |
| GitHub source | `TJmosh/coinsnipe-hub-repo` is **NOT assessed** (`gh` cannot resolve it). See "GitHub repo visibility". |
| Decision log | D25 in the private CoinSnipe decisions log (Agent X workspace). Approved 2026-10-23 with protection as the recommended default. |
| User confirmation | 2026-10-28, cited from the CoinSnipe board task CSN-004 description, line "USER DECISION 2026-10-28: private" |
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
5. If the All Deployments option is missing or unavailable, do not guess a workaround. Contact Vercel support and record the answer here. Stop and tell the orchestrator so the alternatives (password protection on Pro, or private GitHub repo plus deleting the public deployment) can be decided.
6. Wait a minute, then run the verification commands below. If a check still returns 200, redeploy the production deployment and check again. If it still returns 200, contact Vercel support.

Optional, needed before the sync script can run again (see "Sync script impact"):

7. Still under **Deployment Protection**, find **Protection Bypass for Automation** and create a bypass secret for the hub project.
8. Store that secret in your local secret manager. Do not paste it into chat, into a repo file, or into a shell command.

### Rollback

Turning Vercel Authentication off (setting it back to no protection in the same Deployment Protection section) **re-exposes the hub publicly** at `https://coinsnipe-hub-repo.vercel.app`, including the internal costs and pricing. Do this only as an explicit decision. Afterwards, re-run the verification commands below to confirm the state you intended.

### Bypass secret rotation

If the Protection Bypass for Automation secret leaks:

1. Before changing anything, save the current (old) secret into an environment variable so it can be tested after rotation. Use a hidden prompt, not a literal in a command: `read -rs OLD_BYPASS && export OLD_BYPASS`, then paste the value.
2. In the same Deployment Protection section, revoke it or regenerate it (labels may differ). Revoke first if you are not sure which action is available.
3. Save the new value the same way: `read -rs VERCEL_AUTOMATION_BYPASS_SECRET && export VERCEL_AUTOMATION_BYPASS_SECRET`. Update the copy in your local secret store and in any environment that held the old one (for example, the sync script's environment once it exists).
4. Verify the new secret is accepted. This check only means something if the hub is protected. An unprotected hub returns 200 to every request, including any value, so first confirm that an anonymous request with **no** bypass header is protected. Protected means: status `401`, or a `3xx` whose redirect host is exactly `vercel.com`, and the status is not `000`.

   ```
   curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://coinsnipe-hub-repo.vercel.app/
   ```

   If that anonymous result is not protected, **stop**. Do not run the new-secret check, and re-check the Vercel setting first.

   Only after the anonymous request is protected, an empty variable is never a pass. Guard first, then this must print `200`:

   ```
   test -n "$VERCEL_AUTOMATION_BYPASS_SECRET" || { echo "VERCEL_AUTOMATION_BYPASS_SECRET is empty: not a pass"; exit 1; }
   curl -sS -o /dev/null -w '%{http_code}\n' -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" https://coinsnipe-hub-repo.vercel.app/
   ```

5. Verify the old secret is revoked. An empty `OLD_BYPASS` is never a pass. Guard first, then run the check. Note the `-w` format, which prints the redirect host:

   ```
   test -n "$OLD_BYPASS" || { echo "OLD_BYPASS is empty: not a pass"; exit 1; }
   curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' -H "x-vercel-protection-bypass: $OLD_BYPASS" https://coinsnipe-hub-repo.vercel.app/
   ```

   The old secret counts as **revoked** only when all of these hold:

   - the status is `401`, or it is a `3xx`;
   - for a `3xx`, the redirect host is exactly `vercel.com`: the hostname equals `vercel.com`, not merely contains it. Lookalikes such as `vercel.com.example.invalid` or `evil-vercel.com` are **not** a pass. A passing output looks like `302 https://vercel.com/sso-api?...`;
   - the status is not `000`. `000` means no response was received, which is not a pass.

   Anything else counts as **not** revoked: `200`, a `3xx` to another host, `000`, or empty output. Do not continue; re-check the rotation in the dashboard first.

6. Run `unset OLD_BYPASS` once the check is done, whatever the result.
7. Use environment-variable indirection only, as above. Never write a literal secret into a command, this repo, chat, or shell history.

## Verification

Anonymous checks, with no cookies and no credentials. Run each URL twice: once with HEAD (`-I`) and once with GET.

A response counts as **protected** when it is either:

- status **401**, or
- a **3xx** whose redirect host is exactly **`vercel.com`** (the hostname equals `vercel.com`; a lookalike that merely contains it does not count).

Anything else (200, any other 3xx, 5xx, or a timeout) **fails** the check. For a 401 the redirect field is empty, which is expected.

HEAD commands:

```
curl -sS -I -o /dev/null -w '%{http_code} %{redirect_url}\n' https://coinsnipe-hub-repo.vercel.app/
curl -sS -I -o /dev/null -w '%{http_code} %{redirect_url}\n' https://coinsnipe-hub-repo.vercel.app/score-lab/coinsnipe-data-and-pricing.html
```

GET commands:

```
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://coinsnipe-hub-repo.vercel.app/
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://coinsnipe-hub-repo.vercel.app/score-lab/coinsnipe-data-and-pricing.html
```

Acceptance: all four checks (two URLs, HEAD and GET) are protected by the definition above. A passing redirect looks like `302 https://vercel.com/...`. Record only the status and the host in this file, never the full redirect URL, which carries a one-time nonce.

### Baseline (anonymous, before any user activation recorded in this task)

| URL | HEAD | GET | Redirect host and path |
|---|---|---|---|
| `/` | 302 | 302 | `vercel.com/sso-api` |
| `/score-lab/coinsnipe-data-and-pricing.html` | 302 | 302 | `vercel.com/sso-api` |

Notes on the baseline:

- By the definition above, the baseline already matches a protected response. The 302 goes to Vercel's SSO gate. Following it ends at `vercel.com/login` with HTTP 200 (checked 2026-11-20, 17:01 UTC). The `_vercel_sso_nonce` cookie also points to Vercel Authentication.
- This does not show that the user activated the setting. The capture cannot tell who enabled the gate or when. Treat the user's activation as **unconfirmed** until the user says it is done and the checks above are re-run and recorded.

### Post-change (PENDING user activation)

| URL | HEAD | GET | Date |
|---|---|---|---|
| `/` | PENDING | PENDING | PENDING |
| `/score-lab/coinsnipe-data-and-pricing.html` | PENDING | PENDING | PENDING |

## GitHub repo visibility

Command: `gh repo view TJmosh/coinsnipe-hub-repo --json visibility`

Result (2026-11-20): **not determined.**

- The `gh` CLI is signed in to a personal account that cannot resolve this repo. The command returned `Could not resolve to a Repository` (exit 1). `gh api repos/TJmosh/coinsnipe-hub-repo` returned 404.
- Anonymous `https://github.com/TJmosh/coinsnipe-hub-repo` and `https://api.github.com/repos/TJmosh/coinsnipe-hub-repo` both returned 404.
- That fits a private repo that this account cannot see. It also fits a wrong owner or repo name. It does not prove either one.
- The GitHub source `TJmosh/coinsnipe-hub-repo` is **not assessed** by this task. The user should confirm the owner and name, then check the repo's visibility in GitHub settings. Changing visibility is a separate decision.

A Vercel-only change does not hide the hub source. If the GitHub repo is public, the content is still readable there.

## Sync script impact (D25 side effect)

The hub mirror is refreshed by `.claude/specs/CoinSnipe/hub/sync-hub.py`. That script lives in the Agent X harness, not in this repo, and it was not edited for CSN-004. It was not run during this task.

- Once protection is on, the script gets no hub content. Its `urllib` fetch follows the redirect and receives the Vercel login page with HTTP 200 (checked read-only on 2026-11-20).
- The script also runs `shutil.rmtree` on `hub/site/` and `hub/text/` before fetching. A run now would delete the mirror and write login-page HTML in its place.
- **Do not run `sync-hub.py` until a bypass is wired in and the script is fixed.** The fail-closed fix (abort before `rmtree` when the final URL is not the hub, or when a fetch is not 200 HTML) and sending the bypass header are tracked as **AX-CSN-004-FOLLOWUP-1** on the harness board. That fix is not done.
- Bypass config, not yet set anywhere:
  - Secret source: Vercel project, Settings, Deployment Protection, Protection Bypass for Automation.
  - Env var name the sync script would read: `VERCEL_AUTOMATION_BYPASS_SECRET`. It replaces the earlier proposed name `VERCEL_PROTECTION_BYPASS_SECRET`. The value is never written to the repo.
  - Header sent on requests: `x-vercel-protection-bypass`.
  - Provenance: the name and header are as read in Vercel's public automation-bypass docs (https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation) during review on 2026-11-20. The user should confirm both in the dashboard before relying on them. `VERCEL_AUTOMATION_BYPASS_SECRET` is the name Vercel's docs give to the secret it sets inside deployments; the local env var named here is a convention for the sync script, not a Vercel requirement.
  - Status: **not configured**.

`.env.example` is not changed, by decision. The CoinSnipe app does not read the hub, and the sync script lives in the harness, so listing the variable in this repo would mislead readers.

## Sensitive content

This file is in the public CoinSnipe repo. It holds no secret values, no internal costs, and no pricing. It names the GitHub owner `TJmosh` as recorded on the board. That owner name is not a secret. Keep the file free of secret values, costs, and pricing when updating it.
