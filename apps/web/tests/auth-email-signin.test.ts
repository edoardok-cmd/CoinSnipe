import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Adapter } from 'next-auth/adapters';
import { describe, expect, it, vi } from 'vitest';
import { emailSignInTarget, targetFromSignInResult } from '../lib/auth/emailSignIn';
import { sendMagicLink } from '../lib/auth/magicLinkSender';
import { InMemoryRateLimitStore, MAGIC_LINK_EMAIL_LIMIT } from '../lib/auth/rateLimit';
import { errorMessage, SIGN_IN_COPY } from '../lib/auth/signInCopy';
import { createTokenGate, hashVerificationToken } from '../lib/auth/tokenGate';

describe('sign-in page result handling (CSN-050 task F1)', () => {
  it('success: the verify-request URL shows "Check your email"', () => {
    expect(
      targetFromSignInResult(
        'http://localhost:3000/api/auth/verify-request?provider=resend&type=email',
      ),
    ).toBe('/sign-in?check=1');
  });

  it('a refused or failed send returns an error URL and never shows "Check your email"', () => {
    const refused = targetFromSignInResult('http://localhost:3000/sign-in?error=Configuration');
    expect(refused).toBe('/sign-in?error=Configuration');
    expect(errorMessage('Configuration')).toBe(SIGN_IN_COPY.errors.emailSignin);
    expect(targetFromSignInResult('/sign-in?error=EmailSignin')).toBe('/sign-in?error=EmailSignin');
  });

  it('anything unreadable is an error, not success', () => {
    for (const odd of [undefined, null, 42, '', 'http://localhost:3000/somewhere-else']) {
      expect(targetFromSignInResult(odd)).toBe('/sign-in?error=Default');
    }
  });

  it('emailSignInTarget maps a thrown AuthError to its code and rethrows anything else', async () => {
    const boom = new Error('x');
    const target = await emailSignInTarget(
      async () => {
        throw boom;
      },
      () => 'EmailSignin',
    );
    expect(target).toBe('/sign-in?error=EmailSignin');
    await expect(
      emailSignInTarget(
        async () => {
          throw boom;
        },
        () => null,
      ),
    ).rejects.toBe(boom);
  });

  it('the page action goes through emailSignInTarget and redirects to its result', () => {
    const page = readFileSync(resolve(__dirname, '../app/(auth)/sign-in/page.tsx'), 'utf8');
    expect(page).toMatch(/redirect\(\s*await emailSignInTarget\(/);
    expect(page).not.toContain("redirect('/sign-in?check=1')");
  });
});

describe('refused requests leave no verification token (CSN-050 task F3)', () => {
  const SECRET = 'gate-secret';
  const makeAdapter = () => {
    const rows = new Map<string, string>();
    const adapter = {
      createVerificationToken: vi.fn(
        async (vt: { identifier: string; token: string; expires: Date }) => {
          await Promise.resolve();
          rows.set(vt.token, vt.identifier);
          return vt;
        },
      ),
      useVerificationToken: vi.fn(
        async ({ identifier, token }: { identifier: string; token: string }) => {
          const found = rows.get(token) === identifier;
          rows.delete(token);
          return found ? { identifier, token, expires: new Date() } : null;
        },
      ),
    } as unknown as Adapter;
    return { rows, adapter };
  };
  const vt = (token: string) => ({ identifier: 'a@example.com', token, expires: new Date() });

  it('refusal after the insert deletes the row', async () => {
    const { rows, adapter } = makeAdapter();
    const gate = createTokenGate();
    const wrapped = gate.wrap(adapter);
    await wrapped.createVerificationToken!(vt('h1'));
    expect(rows.size).toBe(1);
    await gate.markRefused('a@example.com', 'h1');
    expect(rows.size).toBe(0);
  });

  it('refusal before the insert skips the write', async () => {
    const { rows, adapter } = makeAdapter();
    const gate = createTokenGate();
    const wrapped = gate.wrap(adapter);
    await gate.markRefused('a@example.com', 'h2');
    await wrapped.createVerificationToken!(vt('h2'));
    expect(rows.size).toBe(0);
  });

  it('refusal landing while the insert is in flight still leaves no row', async () => {
    const { rows, adapter } = makeAdapter();
    const gate = createTokenGate();
    const wrapped = gate.wrap(adapter);
    const inserting = wrapped.createVerificationToken!(vt('h3'));
    await gate.markRefused('a@example.com', 'h3');
    await inserting;
    expect(rows.size).toBe(0);
  });

  it('a token that was not refused is kept', async () => {
    const { rows, adapter } = makeAdapter();
    const gate = createTokenGate();
    await gate.wrap(adapter).createVerificationToken!(vt('keep'));
    await gate.markRefused('a@example.com', 'other');
    expect([...rows.keys()]).toEqual(['keep']);
  });

  it('hashVerificationToken is sha-256 hex of token+secret', async () => {
    const hash = await hashVerificationToken('t', SECRET);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(await hashVerificationToken('t', 'other'));
  });

  const base = () => ({
    identifier: 'a@example.com',
    url: 'https://coinsnipe.test/cb',
    headers: new Headers({ 'x-real-ip': '198.51.100.7' }),
    from: 'x@coinsnipe.test',
    now: 1_700_000_000_000,
  });

  it('sendMagicLink calls onRefused on a rate-limit refusal and on a failed send, not on success', async () => {
    const store = new InMemoryRateLimitStore();
    const onRefused = vi.fn(async () => undefined);
    for (let i = 0; i < MAGIC_LINK_EMAIL_LIMIT; i++) {
      await sendMagicLink({ ...base(), store, send: async () => undefined, onRefused });
    }
    expect(onRefused).not.toHaveBeenCalled();
    await expect(
      sendMagicLink({ ...base(), store, send: async () => undefined, onRefused }),
    ).rejects.toThrow(/rate limit/);
    expect(onRefused).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async () => undefined);
    await expect(
      sendMagicLink({
        ...base(),
        identifier: 'b@example.com',
        store: new InMemoryRateLimitStore(),
        send: async () => {
          throw new Error('resend down');
        },
        onRefused: failing,
      }),
    ).rejects.toThrow('resend down');
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
