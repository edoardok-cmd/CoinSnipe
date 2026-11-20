/**
 * Pins the production wiring seams of the Apple link-intent fix (CSN-050): the real link route
 * and the real auth.ts, with only the outside world (NextAuth, Prisma, next/headers) mocked.
 * Reverting the route's cookie closure or auth.ts's cookie reader makes these fail.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LINK_INTENT_COOKIE, createLinkIntentValue } from '../lib/auth/linkIntent';

const SECRET = 'wiring-secret-wiring-secret-wiring';
const state = vi.hoisted(() => ({
  config: undefined as unknown,
  sessionUserId: null as string | null,
  cookieJar: new Map<string, string>(),
  cookieSet: vi.fn(),
  accountCreate: vi.fn(async (args: unknown) => args),
}));

vi.mock('next-auth', () => ({
  default: (config: unknown) => {
    state.config = config;
    return {
      handlers: {},
      auth: async () => (state.sessionUserId ? { user: { id: state.sessionUserId } } : null),
      signIn: async () => 'https://appleid.apple.com/auth/authorize?x=1',
      signOut: async () => undefined,
    };
  },
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = state.cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: state.cookieSet,
  }),
}));
vi.mock('@coinsnipe/db', () => ({ prisma: { account: { create: state.accountCreate } } }));

type SignIn = (arg: unknown) => Promise<unknown>;
const callbacks = async () => {
  await import('../auth');
  return (state.config as { callbacks: { signIn: SignIn } }).callbacks;
};

beforeEach(() => {
  state.sessionUserId = null;
  state.cookieJar.clear();
  state.cookieSet.mockClear();
  state.accountCreate.mockClear();
  process.env['AUTH_SECRET'] = SECRET;
});

describe('link route wiring', () => {
  const post = async (provider: string) => {
    state.sessionUserId = 'u1';
    const { POST } = await import('../app/api/v1/me/accounts/link/route');
    process.env['AUTH_APPLE_ID'] = 'apple-id';
    process.env['AUTH_APPLE_SECRET'] = 'apple-secret';
    process.env['AUTH_GOOGLE_ID'] = 'g-id';
    process.env['AUTH_GOOGLE_SECRET'] = 'g-secret';
    return POST(
      new Request('https://coinsnipe.test/api/v1/me/accounts/link', {
        method: 'POST',
        headers: { origin: 'https://coinsnipe.test', 'content-type': 'application/json' },
        body: JSON.stringify({ provider }),
      }),
    );
  };

  it('the real route sets the intent cookie for Apple', async () => {
    const res = await post('apple');
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${LINK_INTENT_COOKIE}=`));
    expect(cookie).toMatch(/; Path=\/api\/auth\/callback\/apple; HttpOnly; Secure; SameSite=None/);
  });

  it('the real route sets no intent cookie for Google, or when AUTH_SECRET is empty', async () => {
    expect((await post('google')).headers.getSetCookie()).toEqual([]);
    process.env['AUTH_SECRET'] = '';
    expect((await post('apple')).headers.getSetCookie()).toEqual([]);
  });
});

describe('auth.ts wiring', () => {
  const apple = {
    account: { provider: 'apple', providerAccountId: 'ap-1', type: 'oidc', access_token: 'AT' },
    profile: { email: 'a@example.com', email_verified: 'true' },
  };

  it('reads the intent cookie, links through the token-dropping adapter and consumes the cookie', async () => {
    state.cookieJar.set(LINK_INTENT_COOKIE, createLinkIntentValue(SECRET, 'u1', Date.now()));
    const out = await (await callbacks()).signIn(apple);
    expect(out).toBe('/app/profile?linked=apple');
    expect(state.accountCreate).toHaveBeenCalledOnce();
    const data = (state.accountCreate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ userId: 'u1', provider: 'apple', providerAccountId: 'ap-1' });
    expect(data).not.toHaveProperty('access_token');
    expect(state.cookieSet).toHaveBeenCalledWith(LINK_INTENT_COOKIE, '', {
      path: '/api/auth/callback/apple',
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 0,
    });
  });

  it('without a valid intent cookie nothing is linked', async () => {
    expect(await (await callbacks()).signIn(apple)).toBe(true);
    state.cookieJar.set(LINK_INTENT_COOKIE, 'forged.value');
    expect(await (await callbacks()).signIn(apple)).toBe(true);
    expect(state.accountCreate).not.toHaveBeenCalled();
  });
});
