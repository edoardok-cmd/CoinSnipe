import type { Account, NextAuthConfig } from 'next-auth';
import type { Adapter } from 'next-auth/adapters';
import { emitAuthEvent } from './analytics';
import { buildSessionCookie, SESSION_MAX_AGE_SECONDS, SESSION_UPDATE_AGE_SECONDS } from './cookies';
import type { ProviderProfile } from './linking';
import { handleOAuthSignIn } from './oauthSignIn';

/** Where each kind of login lands (CSN-050). Auth.js sends brand-new users to pages.newUser. */
export const FIRST_LOGIN_PATH = '/app/onboarding';
export const HOME_PATH = '/app';

export interface AuthConfigDeps {
  adapter: Adapter;
  providers: NextAuthConfig['providers'];
  isProduction: boolean;
  /** Validated session user of the current request, or null. */
  getSessionUserId(): Promise<string | null>;
  /** User id from a valid link-intent cookie (Apple explicit linking), or null. */
  getIntentUserId(): Promise<string | null>;
  consumeIntent(): Promise<void>;
  linkAccount(userId: string, account: Account): Promise<void>;
}

/**
 * The Auth.js options, built from injected dependencies so tests can inspect and call them
 * without a database. auth.ts wires the real ones.
 */
export function buildAuthConfig(deps: AuthConfigDeps): NextAuthConfig {
  return {
    adapter: deps.adapter,
    providers: deps.providers,
    session: {
      strategy: 'database',
      maxAge: SESSION_MAX_AGE_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    cookies: { sessionToken: buildSessionCookie(deps.isProduction) },
    useSecureCookies: deps.isProduction,
    pages: { signIn: '/sign-in', error: '/sign-in', newUser: FIRST_LOGIN_PATH },
    // allowDangerousEmailAccountLinking is never set: linking is explicit (lib/auth/linking.ts).
    callbacks: {
      async signIn({ account, profile }) {
        const intentUserId = await deps.getIntentUserId();
        return handleOAuthSignIn({
          account,
          profile: profile as ProviderProfile | undefined,
          sessionUserId: await deps.getSessionUserId(),
          intentUserId,
          linkAccount: (userId) => deps.linkAccount(userId, account as Account),
          consumeIntent: () => void deps.consumeIntent().catch(() => undefined),
        });
      },
      async session({ session, user }) {
        if (session.user) session.user.id = user.id;
        return session;
      },
      async redirect({ url, baseUrl }) {
        if (url.startsWith('/') && !url.startsWith('//')) return `${baseUrl}${url}`;
        try {
          if (new URL(url).origin === baseUrl) return url;
        } catch {
          // fall through
        }
        return `${baseUrl}${HOME_PATH}`;
      },
    },
    events: {
      async signIn({ account, isNewUser }) {
        if (isNewUser && account) emitAuthEvent('signup_completed', account.provider);
      },
    },
  };
}
