import { emitAuthEvent } from './analytics';
import { checkMagicLinkLimit, clientIp, type RateLimitStore } from './rateLimit';
import { renderMagicLinkEmail } from '../email/magicLink';

export class MagicLinkRateLimitedError extends Error {
  constructor(readonly limitedBy: 'email' | 'ip') {
    super(`Magic link rate limit reached (${limitedBy})`);
    this.name = 'MagicLinkRateLimitedError';
  }
}

export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Single enforcement point for the magic-link limits: every path (the Auth.js route and the
 * sign-in server action) ends in sendVerificationRequest. The email address never goes into
 * an error message or an analytics property.
 */
export async function sendMagicLink(input: {
  identifier: string;
  url: string;
  headers: Headers;
  from: string;
  store: RateLimitStore;
  send: (email: OutgoingEmail) => Promise<void>;
  now?: number;
}): Promise<void> {
  const verdict = await checkMagicLinkLimit(input.store, {
    email: input.identifier,
    ip: clientIp(input.headers),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (!verdict.allowed) throw new MagicLinkRateLimitedError(verdict.limitedBy);

  emitAuthEvent('signup_started', 'resend');
  const { subject, html, text } = renderMagicLinkEmail(input.url);
  await input.send({ from: input.from, to: input.identifier, subject, html, text });
}
