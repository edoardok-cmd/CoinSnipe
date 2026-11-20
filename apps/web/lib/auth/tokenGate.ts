import type { Adapter, VerificationToken } from 'next-auth/adapters';

/**
 * Keeps refused magic-link requests from leaving a verification_tokens row (CSN-050).
 *
 * Auth.js runs sendVerificationRequest and adapter.createVerificationToken at the same time
 * (Promise.all), so a refusal can land before or after the insert. Whichever happens second
 * cleans up: a refusal marks the hashed token, the adapter wrapper skips a marked insert, and
 * re-checks the mark once its insert finishes, deleting the row if the mark arrived meanwhile.
 */
export interface TokenGate {
  /** Called from sendVerificationRequest when the request is refused or the send failed. */
  markRefused(identifier: string, hashedToken: string): Promise<void>;
  wrap(adapter: Adapter): Adapter;
}

const MARK_TTL_MS = 5 * 60 * 1000;

/** The hash Auth.js stores: sha-256 hex of token + secret. */
export async function hashVerificationToken(token: string, secret: string): Promise<string> {
  const data = new TextEncoder().encode(`${token}${secret}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function createTokenGate(now: () => number = Date.now): TokenGate {
  const refused = new Map<string, number>();
  const prune = () => {
    for (const [key, at] of refused) if (now() - at > MARK_TTL_MS) refused.delete(key);
  };
  let base: Adapter | undefined;
  const remove = async (identifier: string, token: string) => {
    await base?.useVerificationToken?.({ identifier, token });
  };

  return {
    async markRefused(identifier, hashedToken) {
      prune();
      refused.set(hashedToken, now());
      await remove(identifier, hashedToken);
    },
    wrap(adapter) {
      base = adapter;
      const create = adapter.createVerificationToken;
      if (!create) return adapter;
      return {
        ...adapter,
        createVerificationToken: async (vt: VerificationToken) => {
          if (refused.has(vt.token)) return vt;
          const created = await create.call(adapter, vt);
          if (refused.has(vt.token)) await remove(vt.identifier, vt.token);
          return created;
        },
      };
    },
  };
}
