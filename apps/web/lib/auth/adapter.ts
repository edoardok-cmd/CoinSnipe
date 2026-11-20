import type { Adapter, AdapterAccount } from 'next-auth/adapters';

/**
 * Data minimisation (CSN-003-FOLLOWUP-3, CSN-050): CoinSnipe only signs users in and never
 * calls Google or Apple afterwards, so the provider tokens are dropped before the Prisma
 * adapter writes the accounts row. The columns stay in the schema and stay null.
 */
const DROPPED_TOKEN_FIELDS = ['access_token', 'refresh_token', 'id_token'] as const;

export function stripProviderTokens(account: AdapterAccount): AdapterAccount {
  const copy: Record<string, unknown> = { ...account };
  for (const field of DROPPED_TOKEN_FIELDS) delete copy[field];
  return copy as unknown as AdapterAccount;
}

export function withTokenMinimisation(adapter: Adapter): Adapter {
  const base = adapter.linkAccount;
  if (!base) return adapter;
  return { ...adapter, linkAccount: (account) => base(stripProviderTokens(account)) };
}
