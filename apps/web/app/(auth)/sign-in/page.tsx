import { redirect } from 'next/navigation';
import { AuthError } from 'next-auth';
import { auth, signIn } from '../../../auth';
import { emailSignInTarget } from '../../../lib/auth/emailSignIn';
import { beginOAuthSignIn } from '../../../lib/auth/oauthStart';
import { enabledProviders } from '../../../lib/auth/providers';
import { errorMessage, safeCallbackPath, SIGN_IN_COPY } from '../../../lib/auth/signInCopy';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ error?: string; check?: string; callbackUrl?: string }>;

export const metadata = { title: 'Sign in | CoinSnipe', robots: { index: false } };

export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const callback = safeCallbackPath(params.callbackUrl);
  if (await auth()) redirect(callback ?? '/app');

  const providers = enabledProviders(process.env);

  async function emailAction(formData: FormData) {
    'use server';
    const email = String(formData.get('email') ?? '').trim();
    redirect(
      await emailSignInTarget(
        () =>
          signIn('resend', {
            email,
            redirect: false,
            ...(callback ? { redirectTo: callback } : {}),
          }),
        (error) => (error instanceof AuthError ? error.type : null),
      ),
    );
  }

  async function oauthAction(formData: FormData) {
    'use server';
    const provider = String(formData.get('provider'));
    if (provider !== 'google' && provider !== 'apple') redirect('/sign-in?error=Default');
    await beginOAuthSignIn(provider, (id) => signIn(id, callback ? { redirectTo: callback } : {}));
  }

  if (params.check) {
    return (
      <main className="mx-auto max-w-md px-6 py-16">
        <h1 className="text-2xl font-semibold">{SIGN_IN_COPY.checkEmailTitle}</h1>
        <p className="mt-3" role="status">
          {SIGN_IN_COPY.checkEmailBody}
        </p>
      </main>
    );
  }

  const error = errorMessage(params.error);
  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-2xl font-semibold">{SIGN_IN_COPY.title}</h1>
      <p className="mt-3">{SIGN_IN_COPY.lead}</p>
      {error ? (
        <p className="mt-4" role="alert">
          {error}
        </p>
      ) : null}

      {providers.includes('resend') ? (
        <form action={emailAction} className="mt-6 flex flex-col gap-3">
          <label htmlFor="email">{SIGN_IN_COPY.emailLabel}</label>
          <input
            id="email"
            name="email"
            type="email"
            required
            maxLength={254}
            autoComplete="email"
            className="rounded border px-3 py-2"
          />
          <button type="submit" className="rounded bg-black px-4 py-2 text-white">
            {SIGN_IN_COPY.emailButton}
          </button>
          <p className="text-sm">{SIGN_IN_COPY.emailNote}</p>
        </form>
      ) : null}

      {(['google', 'apple'] as const)
        .filter((id) => providers.includes(id))
        .map((id) => (
          <form action={oauthAction} key={id} className="mt-3">
            <input type="hidden" name="provider" value={id} />
            <button type="submit" className="w-full rounded border px-4 py-2">
              {SIGN_IN_COPY[id]}
            </button>
          </form>
        ))}
    </main>
  );
}
