# Accounts: sign-in setup (CSN-050)

Auth.js v5 with the Prisma adapter. One page (`/sign-in`) serves sign-up and log-in. Credentials are the account owner's: never paste them into chat or commit them. Names are listed in `.env.example`.

## How it behaves

- Sessions are stored in the database (`strategy: 'database'`), so they can be revoked. Cookie: `authjs.session-token` (`__Secure-` prefix on https), `HttpOnly`, `SameSite=Lax`, `Secure` in production, 30 days.
- After a brand-new account is created the user lands on `/app/onboarding`; every later login lands on `/app`. (Auth.js `pages.newUser`; a user who abandons onboarding is sent to `/app` next time, so the `/app` page should redirect to onboarding while `profiles.onboarding_done_at` is null: CSN-051.)
- `middleware.ts` protects `/app/**` (redirect to `/sign-in?callbackUrl=...`) and `/api/v1/me/**` (401 JSON). Middleware runs on the edge, where Prisma cannot run, so it only checks that a session cookie is present. Every handler under `/api/v1/me/**` and every server page under `/app/**` must also call `requireSessionUserId()` (`lib/auth/session.ts`), which looks the session up in the database. A forged cookie passes middleware and fails there.
- Provider tokens are not stored: the `linkAccount` wrapper (`lib/auth/adapter.ts`) drops `access_token`, `refresh_token` and `id_token`.
- A provider is offered only when its env vars are all set.

## Magic link (Resend)

1. Create a Resend account, verify the sending domain (SPF and DKIM records at the DNS host), create an API key with "Sending access".
2. Set `RESEND_API_KEY` and `EMAIL_FROM` (for example `CoinSnipe <login@your-domain>`).
3. The link is valid 15 minutes and works once. Limits: 5 per email address per hour and 20 per IP per hour.

Client IP assumption: the per-IP limit assumes a trusted proxy in front of the app (Vercel). It uses `x-real-ip` when present, otherwise the last `x-forwarded-for` entry (the one the proxy appended); earlier entries are client-supplied and ignored. If the app is ever hosted without such a proxy, a client can pick its own IP bucket, and only the per-email limit still holds.

Rate-limit storage: the default store is **in memory** (`lib/auth/rateLimit.ts`), so counts are per server instance and reset on restart; on Vercel the effective limit can be higher than the nominal one. There is no rate-limit table in the schema. To make it exact, add a table (database owner) or Redis and implement `RateLimitStore.hit()` against it.

Local testing without Resend: point the Resend SDK at a local stub with `RESEND_BASE_URL=http://127.0.0.1:4010` (see `apps/web/e2e/auth.spec.ts`).

## Google

1. Google Cloud Console > APIs & Services > OAuth consent screen: configure the app (scopes `openid`, `email`, `profile`).
2. Credentials > Create OAuth client ID > Web application.
3. Authorised redirect URIs: `https://<domain>/api/auth/callback/google` (and `http://localhost:3000/api/auth/callback/google` for local use).
4. Set `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`.

## Apple (Sign in with Apple)

Needs an Apple Developer Program membership.

1. Certificates, Identifiers & Profiles > Identifiers > App IDs: create (or use) an App ID with "Sign in with Apple" enabled. Note the **Team ID** (top right).
2. Identifiers > Services IDs: create a Services ID (for example `ai.coinsnipe.web`). This is `AUTH_APPLE_ID`. Enable "Sign in with Apple" > Configure: primary App ID from step 1, domain `<domain>`, return URL `https://<domain>/api/auth/callback/apple`. Apple does not accept `localhost`; test with a tunnel hostname.
3. Keys: create a key with "Sign in with Apple" enabled, linked to the App ID. Download the `.p8` file once (Apple shows it once) and note the **Key ID**.
4. Private relay email: Keys > Configure the key's "Email Sources" (Certificates, Identifiers & Profiles > More > Configure Sign in with Apple for Email Communication): register your sending domain and the exact `EMAIL_FROM` address so mail to `@privaterelay.appleid.com` addresses is delivered. Users who choose "Hide My Email" appear with a relay address; treat it as a normal email.
5. Generate the client secret, a JWT signed with the `.p8` key (ES256): `iss` = Team ID, `sub` = Services ID, `aud` = `https://appleid.apple.com`, `iat`/`exp` (maximum 6 months), header `kid` = Key ID. Auth.js documents a generator at https://authjs.dev/getting-started/providers/apple. Set the result as `AUTH_APPLE_SECRET`. **It expires: put a reminder in the calendar to regenerate it before six months.**
6. Set `AUTH_APPLE_ID` (Services ID) and `AUTH_APPLE_SECRET`.

## Account linking

`allowDangerousEmailAccountLinking` stays off. A Google or Apple login whose email matches an existing account is refused with a message asking the user to sign in with an email link first. Linking is explicit, from Profile:

- `POST /api/v1/me/accounts/link` with `{"provider":"google"|"apple"}` (signed in, same-origin) returns the Auth.js URL to start the flow.
- The `signIn` callback (`lib/auth/config.ts`, logic in `lib/auth/oauthSignIn.ts`) accepts a provider login only when the provider reports the email as verified (`lib/auth/linking.ts`).
- Google: the callback is a normal GET, so the session cookie arrives and Auth.js attaches the provider account to that session's user.
- Apple: the callback is a cross-site form POST, and browsers do not send the `SameSite=Lax` session cookie on it. For Apple the link route therefore also sets a link-intent cookie (`lib/auth/linkIntent.ts`): `__Secure-csn-link-intent`, HMAC-signed with `AUTH_SECRET`, `HttpOnly; Secure; SameSite=None`, path-limited to `/api/auth/callback/apple`, valid 10 minutes. The callback verifies it and links the Apple account to the user named in it (then redirects to `/app/profile?linked=apple`; failures go to `/app/profile?link_error=unverified-email|already-linked`, which the Profile page should show). This is covered by unit tests only; confirm it once with a real Apple login. `Secure` cookies need https (localhost counts as secure in Chrome and Firefox, not in Safari).

## Log out everywhere

`DELETE /api/v1/me/sessions` (signed in, same-origin) deletes every session row of the user and clears the cookie on the calling device.

## Analytics

`signup_started` (magic link requested) and `signup_completed` (a new account was created) carry only `{ method: 'email' | 'google' | 'apple' }`. No analytics client is wired yet: install one with `setAuthAnalyticsSink()` in `lib/auth/analytics.ts`.
