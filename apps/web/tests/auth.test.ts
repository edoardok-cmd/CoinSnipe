import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NextRequest } from 'next/server';
import type { Adapter, AdapterAccount } from 'next-auth/adapters';
import {
  buildAuthConfig,
  FIRST_LOGIN_PATH,
  HOME_PATH,
  type AuthConfigDeps,
} from '../lib/auth/config';
import {
  createLinkIntentValue,
  linkIntentSetCookie,
  verifyLinkIntentValue,
} from '../lib/auth/linkIntent';
import { handleOAuthSignIn } from '../lib/auth/oauthSignIn';
import { beginOAuthSignIn } from '../lib/auth/oauthStart';
import { describe, expect, it, vi } from 'vitest';
import { lintSource, type Allowlist, type Rule } from '../../../tools/copy-lint/index';
import { config as middlewareConfig, middleware } from '../middleware';
import { decideAccess } from '../lib/auth/access';
import { stripProviderTokens, withTokenMinimisation } from '../lib/auth/adapter';
import { setAuthAnalyticsSink, emitAuthEvent, type AuthEvent } from '../lib/auth/analytics';
import {
  buildSessionCookie,
  hasSessionCookie,
  SECURE_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from '../lib/auth/cookies';
import { decideOAuthSignIn, isProviderEmailVerified } from '../lib/auth/linking';
import { MagicLinkRateLimitedError, sendMagicLink } from '../lib/auth/magicLinkSender';
import { handleLinkProvider, handleLogOutEverywhere } from '../lib/auth/meHandlers';
import { enabledProviders } from '../lib/auth/providers';
import {
  checkMagicLinkLimit,
  clientIp,
  InMemoryRateLimitStore,
  MAGIC_LINK_EMAIL_LIMIT,
  MAGIC_LINK_IP_LIMIT,
  MAGIC_LINK_WINDOW_MS,
} from '../lib/auth/rateLimit';
import { errorMessage, safeCallbackPath, SIGN_IN_COPY } from '../lib/auth/signInCopy';
import { logOutEverywhere } from '../lib/auth/sessions';
import { MAGIC_LINK_COPY, renderMagicLinkEmail } from '../lib/email/magicLink';

const root = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

const SECRET = 'test-secret-test-secret-test-secret';
const NOW = 1_700_000_000_000;

function testConfig(over: Partial<AuthConfigDeps> & { intentUserId?: string | null } = {}) {
  const { intentUserId, ...rest } = over;
  return buildAuthConfig({
    adapter: {} as Adapter,
    providers: [],
    isProduction: true,
    getSessionUserId: async () => null,
    getIntentUserId: async () => intentUserId ?? null,
    consumeIntent: async () => undefined,
    linkAccount: async () => undefined,
    ...rest,
  });
}

describe('session cookie configuration (CSN-050)', () => {
  it('is httpOnly, SameSite=Lax and path / in every environment', () => {
    for (const prod of [true, false]) {
      const { options } = buildSessionCookie(prod);
      expect(options.httpOnly).toBe(true);
      expect(options.sameSite).toBe('lax');
      expect(options.path).toBe('/');
    }
  });

  it('is Secure with the __Secure- prefix in production only', () => {
    expect(buildSessionCookie(true)).toMatchObject({
      name: SECURE_SESSION_COOKIE_NAME,
      options: { secure: true },
    });
    expect(buildSessionCookie(false)).toMatchObject({
      name: SESSION_COOKIE_NAME,
      options: { secure: false },
    });
  });

  it('the Auth.js config uses database sessions, the pinned cookie and no dangerous linking', () => {
    for (const prod of [true, false]) {
      const cfg = testConfig({ isProduction: prod });
      expect(cfg.session?.strategy).toBe('database');
      expect(cfg.cookies?.sessionToken).toEqual(buildSessionCookie(prod));
      expect(cfg.useSecureCookies).toBe(prod);
      expect(cfg.pages).toEqual({
        signIn: '/sign-in',
        error: '/sign-in',
        newUser: '/app/onboarding',
      });
      expect(JSON.stringify(cfg)).not.toContain('allowDangerousEmailAccountLinking');
    }
  });
});

describe('middleware (CSN-050)', () => {
  const call = (path: string, cookie?: string) =>
    middleware(
      new NextRequest(`http://localhost:3000${path}`, cookie ? { headers: { cookie } } : {}),
    );

  it('redirects /app/** to the sign-in page when logged out, keeping the target', () => {
    const res = call('/app/home?x=1');
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.pathname).toBe('/sign-in');
    expect(location.searchParams.get('callbackUrl')).toBe('/app/home?x=1');
  });

  it('redirects bare /app too', () => {
    expect(call('/app').status).toBe(307);
  });

  it('answers /api/v1/me/** with a 401 JSON body when logged out', async () => {
    const res = call('/api/v1/me/sessions');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).error.code).toBe('unauthorized');
  });

  it('lets a request with a session cookie through (either cookie name)', () => {
    for (const name of [SESSION_COOKIE_NAME, SECURE_SESSION_COOKIE_NAME]) {
      expect(call('/app', `${name}=abc`).headers.get('x-middleware-next')).toBe('1');
      expect(call('/api/v1/me/x', `${name}=abc`).headers.get('x-middleware-next')).toBe('1');
    }
  });

  it('does not touch public paths or look-alike prefixes', () => {
    expect(decideAccess('/', '', false).action).toBe('next');
    expect(decideAccess('/sign-in', '', false).action).toBe('next');
    expect(decideAccess('/application', '', false).action).toBe('next');
    expect(decideAccess('/api/v1/meta', '', false).action).toBe('next');
    expect(decideAccess('/api/calendar/upcoming', '', false).action).toBe('next');
  });

  it('matcher covers exactly the two protected trees', () => {
    expect(middlewareConfig.matcher).toEqual(['/app/:path*', '/api/v1/me/:path*']);
    expect(hasSessionCookie(() => false)).toBe(false);
  });
});

describe('magic link rate limits (CSN-050)', () => {
  const t0 = 1_700_000_000_000;

  it('allows 5 per email per hour and blocks the 6th', async () => {
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < MAGIC_LINK_EMAIL_LIMIT; i++) {
      // Distinct IPs so only the email counter can trip.
      expect(
        await checkMagicLinkLimit(store, { email: 'a@example.com', ip: `10.0.0.${i}`, now: t0 }),
      ).toEqual({
        allowed: true,
      });
    }
    expect(
      await checkMagicLinkLimit(store, { email: 'a@example.com', ip: '10.0.1.1', now: t0 }),
    ).toEqual({
      allowed: false,
      limitedBy: 'email',
    });
  });

  it('treats email case and spacing as the same address', async () => {
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < MAGIC_LINK_EMAIL_LIMIT; i++) {
      await checkMagicLinkLimit(store, { email: 'A@Example.com ', ip: `10.0.0.${i}`, now: t0 });
    }
    const verdict = await checkMagicLinkLimit(store, {
      email: 'a@example.com',
      ip: '10.9.9.9',
      now: t0,
    });
    expect(verdict.allowed).toBe(false);
  });

  it('allows 20 per IP per hour and blocks the 21st', async () => {
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < MAGIC_LINK_IP_LIMIT; i++) {
      expect(
        (
          await checkMagicLinkLimit(store, {
            email: `u${i}@example.com`,
            ip: '203.0.113.9',
            now: t0,
          })
        ).allowed,
      ).toBe(true);
    }
    expect(
      await checkMagicLinkLimit(store, { email: 'new@example.com', ip: '203.0.113.9', now: t0 }),
    ).toEqual({
      allowed: false,
      limitedBy: 'ip',
    });
    // A different IP is unaffected.
    expect(
      (await checkMagicLinkLimit(store, { email: 'new@example.com', ip: '203.0.113.10', now: t0 }))
        .allowed,
    ).toBe(true);
  });

  it('frees the budget after the one-hour window', async () => {
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < MAGIC_LINK_EMAIL_LIMIT + 1; i++) {
      await checkMagicLinkLimit(store, { email: 'a@example.com', ip: `10.0.0.${i}`, now: t0 });
    }
    const later = t0 + MAGIC_LINK_WINDOW_MS + 1;
    expect(
      (await checkMagicLinkLimit(store, { email: 'a@example.com', ip: '10.0.5.5', now: later }))
        .allowed,
    ).toBe(true);
  });

  it('reads the client IP from x-real-ip, else the proxy-appended last x-forwarded-for entry', () => {
    expect(clientIp(new Headers({ 'x-real-ip': '3.3.3.3', 'x-forwarded-for': '9.9.9.9' }))).toBe(
      '3.3.3.3',
    );
    // A client-supplied first entry must not choose the bucket.
    expect(clientIp(new Headers({ 'x-forwarded-for': '6.6.6.6, 2.2.2.2' }))).toBe('2.2.2.2');
    expect(clientIp(new Headers({ 'x-forwarded-for': '1.1.1.1' }))).toBe('1.1.1.1');
    expect(clientIp(new Headers())).toBe('unknown');
  });

  it('sendMagicLink sends within the limit and throws MagicLinkRateLimitedError beyond it', async () => {
    const store = new InMemoryRateLimitStore();
    const send = vi.fn(async () => undefined);
    const run = () =>
      sendMagicLink({
        identifier: 'a@example.com',
        url: 'https://coinsnipe.test/api/auth/callback/resend?token=t',
        headers: new Headers({ 'x-forwarded-for': '198.51.100.1' }),
        from: 'CoinSnipe <login@coinsnipe.test>',
        store,
        send,
        now: t0,
      });
    for (let i = 0; i < MAGIC_LINK_EMAIL_LIMIT; i++) await run();
    expect(send).toHaveBeenCalledTimes(MAGIC_LINK_EMAIL_LIMIT);
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MagicLinkRateLimitedError);
    expect((error as Error).message).not.toContain('example.com');
    expect(send).toHaveBeenCalledTimes(MAGIC_LINK_EMAIL_LIMIT);
  });
});

describe('magic link email (CSN-050)', () => {
  const url = 'https://coinsnipe.test/api/auth/callback/resend?token=abc&email=a%40example.com';
  const rendered = renderMagicLinkEmail(url);

  it('contains the link in html and text and states the 15 minute single-use rule', () => {
    expect(rendered.html).toContain(
      'href="https://coinsnipe.test/api/auth/callback/resend?token=abc&amp;email=a%40example.com"',
    );
    expect(rendered.text).toContain(url);
    expect(rendered.text).toContain('15 minutes');
    expect(rendered.text).toContain('once');
    expect(rendered.subject).toBe('Your CoinSnipe sign-in link');
  });

  it('passes the copy-lint rules (html, text, subject, page copy)', () => {
    const rules = JSON.parse(
      readFileSync(resolve(root, '../../tools/copy-lint/rules.json'), 'utf8'),
    ) as Rule[];
    const allow = JSON.parse(
      readFileSync(resolve(root, '../../tools/copy-lint/allowlist.json'), 'utf8'),
    ) as Allowlist;
    const sources: Record<string, string> = {
      'apps/web/lib/email/magicLink.tsx': read('lib/email/magicLink.tsx'),
      'apps/web/lib/auth/signInCopy.ts': read('lib/auth/signInCopy.ts'),
      'apps/web/app/(auth)/sign-in/page.tsx': read('app/(auth)/sign-in/page.tsx'),
      'apps/web/rendered-email.html.txt': `${rendered.subject}\n${rendered.text}\n${JSON.stringify(MAGIC_LINK_COPY)}`,
      'apps/web/rendered-copy.ts': `export const c = ${JSON.stringify(SIGN_IN_COPY)};`,
    };
    for (const [file, source] of Object.entries(sources)) {
      const findings = lintSource(file, source, rules, allow).filter((f) => f.severity === 'error');
      expect(findings, file).toEqual([]);
    }
  });
});

describe('linkAccount token dropping (CSN-050)', () => {
  const account = {
    userId: 'u1',
    type: 'oidc' as const,
    provider: 'google',
    providerAccountId: 'g-123',
    access_token: 'AT',
    refresh_token: 'RT',
    id_token: 'IT',
    expires_at: 123,
    token_type: 'bearer',
    scope: 'openid email',
  } as AdapterAccount;

  it('removes access, refresh and id tokens and keeps the rest', () => {
    const out = stripProviderTokens(account);
    expect(out).not.toHaveProperty('access_token');
    expect(out).not.toHaveProperty('refresh_token');
    expect(out).not.toHaveProperty('id_token');
    expect(out).toMatchObject({
      userId: 'u1',
      provider: 'google',
      providerAccountId: 'g-123',
      scope: 'openid email',
    });
  });

  it('the wrapped adapter passes only the stripped account to the Prisma adapter', async () => {
    const linkAccount = vi.fn(async () => undefined);
    const adapter = withTokenMinimisation({ linkAccount } as never);
    await adapter.linkAccount?.(account);
    expect(linkAccount).toHaveBeenCalledOnce();
    const passed = (linkAccount.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(Object.keys(passed)).not.toContain('access_token');
    expect(Object.keys(passed)).not.toContain('refresh_token');
    expect(Object.keys(passed)).not.toContain('id_token');
    expect(passed['providerAccountId']).toBe('g-123');
  });
});

describe('log out everywhere (CSN-050)', () => {
  const sameOrigin = (method = 'DELETE', extra: Record<string, string> = {}) =>
    new Request('https://coinsnipe.test/api/v1/me/sessions', {
      method,
      headers: { origin: 'https://coinsnipe.test', ...extra },
    });

  it('deletes every session of the signed-in user and clears the cookie', async () => {
    const deleteAllForUser = vi.fn(async () => 3);
    const res = await handleLogOutEverywhere(sameOrigin(), {
      getUserId: async () => 'u1',
      sessions: { deleteAllForUser },
    });
    expect(res.status).toBe(200);
    expect(deleteAllForUser).toHaveBeenCalledWith('u1');
    expect(await res.json()).toEqual({ ok: true, sessionsRemoved: 3 });
    // Full strings: the __Secure- cookie is ignored by browsers unless it carries Secure.
    expect(res.headers.getSetCookie()).toEqual([
      'authjs.session-token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      '__Secure-authjs.session-token=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    ]);
  });

  it('returns 401 without a valid session and deletes nothing', async () => {
    const deleteAllForUser = vi.fn(async () => 0);
    const res = await handleLogOutEverywhere(sameOrigin(), {
      getUserId: async () => null,
      sessions: { deleteAllForUser },
    });
    expect(res.status).toBe(401);
    expect(deleteAllForUser).not.toHaveBeenCalled();
  });

  it('refuses a cross-site or origin-less request', async () => {
    const deps = {
      getUserId: async () => 'u1',
      sessions: { deleteAllForUser: vi.fn(async () => 1) },
    };
    const cross = new Request('https://coinsnipe.test/api/v1/me/sessions', {
      method: 'DELETE',
      headers: { origin: 'https://evil.test' },
    });
    expect((await handleLogOutEverywhere(cross, deps)).status).toBe(403);
    const none = new Request('https://coinsnipe.test/api/v1/me/sessions', { method: 'DELETE' });
    expect((await handleLogOutEverywhere(none, deps)).status).toBe(403);
    expect(deps.sessions.deleteAllForUser).not.toHaveBeenCalled();
  });

  it('logOutEverywhere removes only the given user through the store', async () => {
    const rows = [
      { id: 's1', userId: 'u1' },
      { id: 's2', userId: 'u1' },
      { id: 's3', userId: 'u2' },
    ];
    const store = {
      deleteAllForUser: async (userId: string) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--)
          if (rows[i]?.userId === userId) rows.splice(i, 1);
        return before - rows.length;
      },
    };
    expect(await logOutEverywhere(store, 'u1')).toBe(2);
    expect(rows).toEqual([{ id: 's3', userId: 'u2' }]);
  });
});

describe('explicit provider linking (CSN-050)', () => {
  it('only a verified provider email may sign in or link', () => {
    expect(isProviderEmailVerified({ email: 'a@example.com', email_verified: true })).toBe(true);
    expect(isProviderEmailVerified({ email: 'a@example.com', email_verified: 'true' })).toBe(true);
    expect(isProviderEmailVerified({ email: 'a@example.com', email_verified: false })).toBe(false);
    expect(isProviderEmailVerified({ email: 'a@example.com', email_verified: 'false' })).toBe(
      false,
    );
    expect(isProviderEmailVerified({ email: 'a@example.com' })).toBe(false);
    expect(isProviderEmailVerified({ email_verified: true })).toBe(false);
    expect(isProviderEmailVerified(undefined)).toBe(false);
  });

  it('classifies a signed-in attempt as a link and refuses an unverified one', () => {
    const verified = { email: 'a@example.com', email_verified: true };
    expect(
      decideOAuthSignIn({ provider: 'google', profile: verified, sessionUserId: 'u1' }),
    ).toEqual({ allow: true, mode: 'link' });
    expect(
      decideOAuthSignIn({ provider: 'apple', profile: verified, sessionUserId: null }),
    ).toEqual({ allow: true, mode: 'sign-in' });
    expect(
      decideOAuthSignIn({
        provider: 'google',
        profile: { email: 'a@example.com', email_verified: false },
        sessionUserId: 'u1',
      }),
    ).toEqual({ allow: false, reason: 'unverified-email' });
  });

  const link = (body: unknown, deps: Partial<Parameters<typeof handleLinkProvider>[1]> = {}) =>
    handleLinkProvider(
      new Request('https://coinsnipe.test/api/v1/me/accounts/link', {
        method: 'POST',
        headers: { origin: 'https://coinsnipe.test', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      {
        getUserId: async () => 'u1',
        isEnabled: () => true,
        startLink: async (p) => `/api/auth/signin/${p}`,
        linkIntentCookie: (userId, p) =>
          p === 'apple' ? linkIntentSetCookie(SECRET, userId, NOW) : null,
        ...deps,
      },
    );

  it('returns the provider URL for a signed-in user', async () => {
    const res = await link({ provider: 'google' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: '/api/auth/signin/google' });
  });

  it('401 when logged out, 400 on a bad provider, 404 when the provider is not configured', async () => {
    expect((await link({ provider: 'google' }, { getUserId: async () => null })).status).toBe(401);
    expect((await link({ provider: 'github' })).status).toBe(400);
    expect((await link({})).status).toBe(400);
    expect((await link({ provider: 'apple' }, { isEnabled: () => false })).status).toBe(404);
  });

  it('Google link: no intent cookie is set, the session cookie carries the user', async () => {
    const res = await link({ provider: 'google' });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('Apple link: sets a path-scoped SameSite=None; Secure; HttpOnly intent cookie for the user', async () => {
    const res = await link({ provider: 'apple' });
    const [cookie] = res.headers.getSetCookie();
    expect(res.headers.getSetCookie()).toHaveLength(1);
    expect(cookie).toMatch(
      /^__Secure-csn-link-intent=[^;]+; Path=\/api\/auth\/callback\/apple; HttpOnly; Secure; SameSite=None; Max-Age=600$/,
    );
    const value = cookie!.split(';')[0]!.split('=').slice(1).join('=');
    expect(verifyLinkIntentValue(SECRET, value, NOW + 1000)).toBe('u1');
  });

  describe('link intent cookie', () => {
    const value = createLinkIntentValue(SECRET, 'u1', NOW);
    it('verifies, expires after 10 minutes, and rejects tampering or another secret', () => {
      expect(verifyLinkIntentValue(SECRET, value, NOW + 599_000)).toBe('u1');
      expect(verifyLinkIntentValue(SECRET, value, NOW + 600_001)).toBeNull();
      expect(verifyLinkIntentValue('other-secret', value, NOW)).toBeNull();
      const [body, sig] = value.split('.');
      const forged = Buffer.from(JSON.stringify({ u: 'victim', e: NOW + 1e9, n: 'x' })).toString(
        'base64url',
      );
      expect(verifyLinkIntentValue(SECRET, `${forged}.${sig}`, NOW)).toBeNull();
      expect(verifyLinkIntentValue(SECRET, `${body}.`, NOW)).toBeNull();
      expect(verifyLinkIntentValue(SECRET, 'garbage', NOW)).toBeNull();
      expect(verifyLinkIntentValue(SECRET, undefined, NOW)).toBeNull();
      expect(verifyLinkIntentValue('', value, NOW)).toBeNull();
    });
  });

  describe('signIn callback (handleOAuthSignIn)', () => {
    const verified = { email: 'a@example.com', email_verified: true };
    const run = (over: Partial<Parameters<typeof handleOAuthSignIn>[0]> = {}) => {
      const linkAccount = vi.fn(async () => undefined);
      const consumeIntent = vi.fn();
      const promise = handleOAuthSignIn({
        account: { provider: 'apple' },
        profile: verified,
        sessionUserId: null,
        intentUserId: null,
        linkAccount,
        consumeIntent,
        ...over,
      });
      return { promise, linkAccount, consumeIntent };
    };

    it('links Apple to the intent user (no session cookie on the cross-site POST) and redirects', async () => {
      const r = run({ intentUserId: 'u1' });
      expect(await r.promise).toBe('/app/profile?linked=apple');
      expect(r.linkAccount).toHaveBeenCalledWith('u1');
      expect(r.consumeIntent).toHaveBeenCalledOnce();
    });

    it('refuses an unverified provider email even with an intent, and links nothing', async () => {
      const r = run({
        intentUserId: 'u1',
        profile: { email: 'a@example.com', email_verified: 'false' },
      });
      expect(await r.promise).toBe('/app/profile?link_error=unverified-email');
      expect(r.linkAccount).not.toHaveBeenCalled();
      expect(r.consumeIntent).toHaveBeenCalledOnce();
    });

    it('reports already-linked when the adapter rejects the duplicate', async () => {
      const r = run({
        intentUserId: 'u1',
        linkAccount: vi.fn(async () => {
          throw new Error('unique');
        }),
      });
      expect(await r.promise).toBe('/app/profile?link_error=already-linked');
    });

    it('with a session (Google) it only enforces the rule and lets Auth.js link', async () => {
      const r = run({ account: { provider: 'google' }, sessionUserId: 'u1' });
      expect(await r.promise).toBe(true);
      expect(r.linkAccount).not.toHaveBeenCalled();
      const bad = run({
        account: { provider: 'google' },
        sessionUserId: 'u1',
        profile: { email: 'a@example.com' },
      });
      expect(await bad.promise).toBe('/app/profile?link_error=unverified-email');
    });

    it('a plain sign-in needs a verified email, never links by itself, and ignores email providers', async () => {
      expect(await run().promise).toBe(true);
      expect(
        await run({ profile: { email: 'a@example.com', email_verified: false } }).promise,
      ).toBe('/sign-in?error=AccessDenied');
      const r = run({ account: { provider: 'resend' }, profile: undefined });
      expect(await r.promise).toBe(true);
    });

    it('the real config callback wires session, intent and link dependencies', async () => {
      const linkAccount = vi.fn(async () => undefined);
      const cfg = testConfig({ intentUserId: 'u7', linkAccount });
      const out = await cfg.callbacks!.signIn!({
        account: { provider: 'apple', providerAccountId: 'ap-1', type: 'oidc' },
        profile: verified,
        user: { id: 'x' } as never,
      } as never);
      expect(out).toBe('/app/profile?linked=apple');
      expect(linkAccount).toHaveBeenCalledWith(
        'u7',
        expect.objectContaining({ providerAccountId: 'ap-1' }),
      );
    });
  });
});

describe('providers, analytics, redirects (CSN-050)', () => {
  it('enables a provider only when its env is complete', () => {
    expect(enabledProviders({})).toEqual([]);
    expect(enabledProviders({ RESEND_API_KEY: 'k' })).toEqual([]);
    expect(
      enabledProviders({
        RESEND_API_KEY: 'k',
        EMAIL_FROM: 'a@b.c',
        AUTH_GOOGLE_ID: 'i',
        AUTH_GOOGLE_SECRET: 's',
        AUTH_APPLE_ID: 'i',
      }),
    ).toEqual(['resend', 'google']);
  });

  it('analytics events carry the method only, never an email', async () => {
    const seen: AuthEvent[] = [];
    setAuthAnalyticsSink((e) => seen.push(e));
    await sendMagicLink({
      identifier: 'secret.person@example.com',
      url: 'https://coinsnipe.test/x',
      headers: new Headers(),
      from: 'x@coinsnipe.test',
      store: new InMemoryRateLimitStore(),
      send: async () => undefined,
    });
    emitAuthEvent('signup_completed', 'google');
    emitAuthEvent('signup_completed', 'unknown-provider');
    expect(seen).toEqual([
      { name: 'signup_started', properties: { method: 'email' } },
      { name: 'signup_completed', properties: { method: 'google' } },
    ]);
    expect(JSON.stringify(seen)).not.toContain('example.com');
    setAuthAnalyticsSink(() => undefined);
  });

  it('a throwing analytics sink never breaks sign-in', () => {
    setAuthAnalyticsSink(() => {
      throw new Error('boom');
    });
    expect(() => emitAuthEvent('signup_started', 'resend')).not.toThrow();
    setAuthAnalyticsSink(() => undefined);
  });

  it('first login goes to onboarding and later logins to Home', () => {
    expect(FIRST_LOGIN_PATH).toBe('/app/onboarding');
    expect(HOME_PATH).toBe('/app');
    expect(testConfig().pages?.newUser).toBe(FIRST_LOGIN_PATH);
  });

  it('the redirect callback keeps logins on our own origin and defaults to Home', async () => {
    const redirect = testConfig().callbacks!.redirect!;
    const base = 'https://coinsnipe.test';
    expect(await redirect({ url: '/app/profile', baseUrl: base })).toBe(`${base}/app/profile`);
    expect(await redirect({ url: `${base}/app`, baseUrl: base })).toBe(`${base}/app`);
    expect(await redirect({ url: 'https://evil.test/x', baseUrl: base })).toBe(`${base}/app`);
    expect(await redirect({ url: '//evil.test', baseUrl: base })).toBe(`${base}/app`);
  });

  it('signup_completed is emitted for new users only, with the method and no email', async () => {
    const seen: AuthEvent[] = [];
    setAuthAnalyticsSink((e) => seen.push(e));
    const signInEvent = testConfig().events!.signIn!;
    await signInEvent({
      user: { email: 'a@example.com' },
      account: { provider: 'google' },
      isNewUser: true,
    } as never);
    await signInEvent({ user: {}, account: { provider: 'google' }, isNewUser: false } as never);
    expect(seen).toEqual([{ name: 'signup_completed', properties: { method: 'google' } }]);
    setAuthAnalyticsSink(() => undefined);
  });

  it('starting Google or Apple sign-in emits signup_started with the method only', async () => {
    const seen: AuthEvent[] = [];
    setAuthAnalyticsSink((e) => seen.push(e));
    const start = vi.fn(async () => undefined);
    await beginOAuthSignIn('google', start);
    await beginOAuthSignIn('apple', start);
    expect(seen).toEqual([
      { name: 'signup_started', properties: { method: 'google' } },
      { name: 'signup_started', properties: { method: 'apple' } },
    ]);
    expect(start.mock.calls).toEqual([['google'], ['apple']]);
    setAuthAnalyticsSink(() => undefined);
  });

  it('the sign-in page starts OAuth through beginOAuthSignIn', () => {
    expect(read('app/(auth)/sign-in/page.tsx')).toContain('beginOAuthSignIn(provider');
  });

  it('only same-site relative callback paths are accepted', () => {
    expect(safeCallbackPath('/app/profile')).toBe('/app/profile');
    expect(safeCallbackPath('//evil.test')).toBeUndefined();
    expect(safeCallbackPath('https://evil.test')).toBeUndefined();
    expect(safeCallbackPath('/\\evil.test')).toBeUndefined();
    for (const bad of [
      '/\t/evil.test',
      '/\n/evil.test',
      '/\r/evil.test',
      '/\u0000/x',
      '/\u007f/x',
      '/%2fevil.test',
      '/%2Fevil.test',
      '/%5cevil.test',
      '/%5Cevil.test',
      '/%09/evil.test',
      '/%0a/evil.test',
      '/%00',
    ]) {
      expect(safeCallbackPath(bad), JSON.stringify(bad)).toBeUndefined();
    }
    expect(safeCallbackPath('/app/profile?tab=a%20b')).toBe('/app/profile?tab=a%20b');
    expect(safeCallbackPath(undefined)).toBeUndefined();
  });

  it('maps Auth.js error codes to calm messages', () => {
    expect(errorMessage(undefined)).toBeNull();
    expect(errorMessage('OAuthAccountNotLinked')).toBe(SIGN_IN_COPY.errors.accountNotLinked);
    expect(errorMessage('Verification')).toBe(SIGN_IN_COPY.errors.verification);
    expect(errorMessage('whatever')).toBe(SIGN_IN_COPY.errors.default);
  });
});
