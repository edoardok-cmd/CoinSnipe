/**
 * Magic-link sign-in email (CSN-050). Educational tone, no market language. The link works
 * once and expires after 15 minutes (the Auth.js Resend provider maxAge).
 */
export const MAGIC_LINK_MAX_AGE_SECONDS = 15 * 60;
export const MAGIC_LINK_SUBJECT = 'Your CoinSnipe sign-in link';

export const MAGIC_LINK_COPY = {
  heading: 'Sign in to CoinSnipe',
  intro: 'Use the button below to sign in. The link works once and expires in 15 minutes.',
  button: 'Sign in to CoinSnipe',
  fallback: 'If the button does not work, copy this address into your browser:',
  ignore:
    'If you did not ask for this email, you can ignore it. Nothing happens until the link is opened.',
} as const;

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/**
 * The email body is built as an escaped string, not rendered with react-dom/server: Next.js
 * refuses that import inside the app bundle, and a transactional email needs no components.
 */
export function magicLinkHtml(url: string): string {
  const href = escapeHtml(url);
  return [
    '<!DOCTYPE html><html lang="en"><body style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;margin:0">',
    '<div style="max-width:480px;margin:0 auto;padding:24px">',
    `<h1 style="font-size:22px">${MAGIC_LINK_COPY.heading}</h1>`,
    `<p>${MAGIC_LINK_COPY.intro}</p>`,
    `<p><a href="${href}" style="display:inline-block;padding:12px 20px;background:#111111;color:#ffffff;border-radius:6px;text-decoration:none">${MAGIC_LINK_COPY.button}</a></p>`,
    `<p style="font-size:13px">${MAGIC_LINK_COPY.fallback}</p>`,
    `<p style="font-size:13px;word-break:break-all">${href}</p>`,
    `<p style="font-size:13px;color:#555555">${MAGIC_LINK_COPY.ignore}</p>`,
    '</div></body></html>',
  ].join('');
}

export function renderMagicLinkEmail(url: string): { subject: string; html: string; text: string } {
  const text = [
    MAGIC_LINK_COPY.heading,
    '',
    MAGIC_LINK_COPY.intro,
    '',
    url,
    '',
    MAGIC_LINK_COPY.ignore,
  ].join('\n');
  return {
    subject: MAGIC_LINK_SUBJECT,
    html: magicLinkHtml(url),
    text,
  };
}
