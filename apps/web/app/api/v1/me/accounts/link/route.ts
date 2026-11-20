import { enabledProviders } from '../../../../../../lib/auth/providers';
import { handleLinkProvider } from '../../../../../../lib/auth/meHandlers';
import { linkIntentSetCookie } from '../../../../../../lib/auth/linkIntent';
import { requireSessionUserId } from '../../../../../../lib/auth/session';
import { signIn } from '../../../../../../auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/v1/me/accounts/link {"provider":"google"|"apple"}: explicit linking from Profile.
 * Returns the provider authorization URL; the client navigates to it. The callback attaches
 * the provider account to the signed-in user only when the provider email is verified
 * (signIn callback in auth.ts).
 */
export async function POST(request: Request): Promise<Response> {
  return handleLinkProvider(request, {
    getUserId: requireSessionUserId,
    isEnabled: (provider) => enabledProviders(process.env).includes(provider),
    // Apple's callback is a cross-site POST without the Lax session cookie: carry the intent.
    linkIntentCookie: (userId, provider) =>
      provider === 'apple' && process.env.AUTH_SECRET
        ? linkIntentSetCookie(process.env.AUTH_SECRET, userId, Date.now())
        : null,
    startLink: async (provider) =>
      (await signIn(provider, { redirect: false, redirectTo: '/app/profile' })) as string,
  });
}
