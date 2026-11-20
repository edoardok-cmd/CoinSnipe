import NextAuth from 'next-auth';
import Apple from 'next-auth/providers/apple';
import Google from 'next-auth/providers/google';
import Resend from 'next-auth/providers/resend';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { Resend as ResendClient } from 'resend';
import { prisma } from '@coinsnipe/db';
import { withTokenMinimisation } from './lib/auth/adapter';
import { emitAuthEvent } from './lib/auth/analytics';
import {
  buildSessionCookie,
  SESSION_MAX_AGE_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
} from './lib/auth/cookies';
import { decideOAuthSignIn } from './lib/auth/linking';
import { sendMagicLink } from './lib/auth/magicLinkSender';
import { enabledProviders, isOAuthProvider } from './lib/auth/providers';
import { defaultRateLimitStore } from './lib/auth/rateLimit';
import { MAGIC_LINK_MAX_AGE_SECONDS } from './lib/email/magicLink';

/** Where each kind of login lands (CSN-050). Auth.js sends brand-new users to pages.newUser. */
export const FIRST_LOGIN_PATH = '/app/onboarding';
export const HOME_PATH = '/app';

const isProduction = process.env.NODE_ENV === 'production';
const enabled = enabledProviders(process.env);

const providers = [
  ...(enabled.includes('resend')
    ? [
        Resend({
          apiKey: process.env.RESEND_API_KEY ?? '',
          from: process.env.EMAIL_FROM ?? '',
          maxAge: MAGIC_LINK_MAX_AGE_SECONDS,
          async sendVerificationRequest({ identifier, url, request }) {
            const client = new ResendClient(process.env.RESEND_API_KEY);
            await sendMagicLink({
              identifier,
              url,
              headers: request.headers,
              from: process.env.EMAIL_FROM ?? '',
              store: defaultRateLimitStore(),
              send: async (email) => {
                const { error } = await client.emails.send(email);
                if (error) throw new Error(`Resend rejected the email: ${error.name}`);
              },
            });
          },
        }),
      ]
    : []),
  ...(enabled.includes('google')
    ? [
        Google({
          clientId: process.env.AUTH_GOOGLE_ID ?? '',
          clientSecret: process.env.AUTH_GOOGLE_SECRET ?? '',
        }),
      ]
    : []),
  ...(enabled.includes('apple')
    ? [
        Apple({
          clientId: process.env.AUTH_APPLE_ID ?? '',
          clientSecret: process.env.AUTH_APPLE_SECRET ?? '',
        }),
      ]
    : []),
];

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: withTokenMinimisation(PrismaAdapter(prisma)),
  providers,
  session: {
    strategy: 'database',
    maxAge: SESSION_MAX_AGE_SECONDS,
    updateAge: SESSION_UPDATE_AGE_SECONDS,
  },
  cookies: { sessionToken: buildSessionCookie(isProduction) },
  useSecureCookies: isProduction,
  pages: { signIn: '/sign-in', error: '/sign-in', newUser: FIRST_LOGIN_PATH },
  // Never set allowDangerousEmailAccountLinking: linking is explicit (lib/auth/linking.ts).
  callbacks: {
    async signIn({ account, profile }) {
      if (!account || !isOAuthProvider(account.provider)) return true;
      // A session at this point means the user started this from Profile (explicit link).
      const current = await auth();
      const decision = decideOAuthSignIn({
        provider: account.provider,
        profile: profile as { email?: string; email_verified?: boolean | string } | undefined,
        sessionUserId: current?.user?.id ?? null,
      });
      return decision.allow;
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
});
