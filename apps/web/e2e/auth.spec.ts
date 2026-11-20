import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';

/**
 * Accounts (CSN-050). The first two tests need only a running build. The sign-up tests also
 * need a database and a Resend stand-in, so they run only with E2E_AUTH=1:
 *
 *   RESEND_BASE_URL=http://127.0.0.1:4010 RESEND_API_KEY=test EMAIL_FROM='CoinSnipe <login@localhost>' \
 *   AUTH_SECRET=<random> AUTH_TRUST_HOST=true DATABASE_URL=<scratch db> pnpm --filter @coinsnipe/web start -p 3555
 *   E2E_AUTH=1 E2E_BASE_URL=http://127.0.0.1:3555 pnpm --filter @coinsnipe/web exec playwright test -c e2e/playwright.config.ts auth.spec.ts
 *
 * The Resend Node SDK honours RESEND_BASE_URL, so this file runs a tiny local server that
 * answers POST /emails and keeps the messages: a test mailbox with no live credentials.
 */
const STUB_PORT = Number(process.env.E2E_MAIL_STUB_PORT ?? 4010);

interface Captured {
  to: string[] | string;
  html: string;
  text: string;
  subject: string;
}

function startMailbox(): { server: Server; mails: Captured[] } {
  const mails: Captured[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/emails') {
        mails.push(JSON.parse(body) as Captured);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'stub-' + mails.length }));
      } else {
        res.writeHead(404).end();
      }
    });
  });
  server.listen(STUB_PORT, '127.0.0.1');
  return { server, mails };
}

test('logged out: /app redirects to the sign-in page', async ({ page }) => {
  await page.goto('/app');
  await expect(page).toHaveURL(/\/sign-in\?callbackUrl=%2Fapp$/);
  await expect(page.getByRole('heading', { name: 'Sign in to CoinSnipe' })).toBeVisible();
});

test('logged out: /api/v1/me/** answers 401 JSON', async ({ request }) => {
  const res = await request.get('/api/v1/me/sessions');
  expect(res.status()).toBe(401);
  expect((await res.json()).error.code).toBe('unauthorized');
});

test.describe('magic link sign-up', () => {
  test.skip(process.env.E2E_AUTH !== '1', 'needs a database and the Resend stand-in (E2E_AUTH=1)');
  let mailbox: ReturnType<typeof startMailbox>;
  test.beforeAll(() => {
    mailbox = startMailbox();
  });
  test.afterAll(() => {
    mailbox.server.close();
  });

  test('new member: link arrives, works once, lands on onboarding, cookie flags are safe', async ({
    page,
    context,
  }) => {
    const email = `e2e-${Date.now()}@example.test`;
    await page.goto('/sign-in');
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    await expect.poll(() => mailbox.mails.length).toBeGreaterThan(0);
    const mail = mailbox.mails.at(-1)!;
    expect(JSON.stringify(mail.to)).toContain(email);
    const link = /href="([^"]+callback\/resend[^"]+)"/
      .exec(mail.html)?.[1]
      ?.replaceAll('&amp;', '&');
    expect(link).toBeTruthy();

    await page.goto(link!);
    await expect(page).toHaveURL(/\/app\/onboarding(\?.*)?$/);

    const session = (await context.cookies()).find((c) => c.name.endsWith('authjs.session-token'));
    expect(session).toBeDefined();
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax' });

    // Single use: the same link, opened again in a fresh browser state, does not sign in.
    await context.clearCookies();
    await page.goto(link!);
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test('sixth request for one address is refused', async ({ page }) => {
    const email = `limit-${Date.now()}@example.test`;
    for (let i = 0; i < 6; i++) {
      await page.goto('/sign-in');
      await page.getByLabel('Email address').fill(email);
      await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
      if (i < 5)
        await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    }
    // Next.js has its own route-announcer alert, so scope to the page content.
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'Wait a little and try again',
    );
    expect(mailbox.mails.filter((m) => JSON.stringify(m.to).includes(email))).toHaveLength(5);
  });
});
