import { auth } from '../../auth';

/**
 * The real session check (middleware only sees the cookie). auth() looks the session token up
 * in the sessions table and returns null when it is missing or expired.
 */
export async function requireSessionUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}
