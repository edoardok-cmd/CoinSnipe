import NextAuth from 'next-auth';
import type { AdapterAccount } from 'next-auth/adapters';
import Apple from 'next-auth/providers/apple';
import Google from 'next-auth/providers/google';
import Resend from 'next-auth/providers/resend';
import { cookies } from 'next/headers';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { Resend as ResendClient } from 'resend';
import { prisma } from '@coinsnipe/db';
import { withTokenMinimisation } from './lib/auth/adapter';
import { buildAuthConfig } from './lib/auth/config';
import {
  LINK_INTENT_CLEAR_OPTIONS,
  LINK_INTENT_COOKIE,
  readIntentUserId,
} from './lib/auth/linkIntent';
import { sendMagicLink } from './lib/auth/magicLinkSender';
import { enabledProviders } from './lib/auth/providers';
import { defaultRateLimitStore } from './lib/auth/rateLimit';
import { MAGIC_LINK_MAX_AGE_SECONDS } from './lib/email/magicLink';

export { FIRST_LOGIN_PATH, HOME_PATH } from './lib/auth/config';

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

const adapter = withTokenMinimisation(PrismaAdapter(prisma));

export const { handlers, auth, signIn, signOut } = NextAuth(
  buildAuthConfig({
    adapter,
    providers,
    isProduction,
    // A session at the signIn callback means the user started this from Profile.
    getSessionUserId: async () => (await auth())?.user?.id ?? null,
    getIntentUserId: async () =>
      readIntentUserId((await cookies()).get(LINK_INTENT_COOKIE)?.value, process.env, Date.now()),
    consumeIntent: async () => {
      // Best effort: the callback runs inside the Auth.js route handler, where cookies are writable.
      try {
        (await cookies()).set(LINK_INTENT_COOKIE, '', LINK_INTENT_CLEAR_OPTIONS);
      } catch {
        // The 5 minute expiry bounds a leftover cookie; ignore.
      }
    },
    linkAccount: async (userId, account) => {
      await adapter.linkAccount?.({ ...account, userId } as AdapterAccount);
    },
  }),
);
