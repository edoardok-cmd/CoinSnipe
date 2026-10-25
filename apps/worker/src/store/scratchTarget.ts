/**
 * Fail-closed guard for the destructive scratch-database test (CSN-024 R5-7).
 *
 * The test truncates tables, so it runs only when every check passes:
 *   - the scheme is postgres:// or postgresql://;
 *   - the host is an allow-listed local scratch host (127.0.0.1 or localhost);
 *   - the port is an allow-listed scratch port (5432 or 55432, the scratch-test-db.sh clusters);
 *   - the database name matches coinsnipe_csn_024_<slug>_<hash8>_test;
 *   - the name equals CSN024_SCRATCH_DB_NAME, the database the operator created for this run.
 *     A name-only match is not enough: another session's scratch database has the same shape.
 *   - the query string carries no connection override. Prisma honours host, hostaddr and other
 *     parameters in DATABASE_URL, so only the allow-listed query keys below are accepted (R6-2).
 *
 * Any failed check refuses. The suite then fails, so a misconfigured run is never silently skipped.
 */

export const SCRATCH_HOSTS: readonly string[] = ['127.0.0.1', 'localhost'];
export const SCRATCH_PORTS: readonly number[] = [5432, 55432];
export const SCRATCH_NAME_PATTERN = /^coinsnipe_csn_024_[a-z0-9_]+_[0-9a-f]{8}_test$/;
export const SCRATCH_NAME_ENV = 'CSN024_SCRATCH_DB_NAME';
/**
 * Query keys that cannot change where the connection goes or which database it names. Anything else
 * (host, hostaddr, port, dbname, user, options, service, unknown keys) is refused on the scratch target.
 */
export const SCRATCH_ALLOWED_QUERY_KEYS: readonly string[] = [
  'sslmode',
  'connection_limit',
  'pool_timeout',
  'connect_timeout',
  'schema',
];

/**
 * Value rule for each allowed key (R2-9). A key name alone is not enough: "sslmode=disable;host=x" carries a
 * host in its value. Each value must match its rule, which admits no host, no '@', no '=', no ';' and no '/'.
 */
export const SCRATCH_QUERY_VALUE_RULES: Readonly<Record<string, RegExp>> = {
  sslmode: /^(disable|allow|prefer|require|verify-ca|verify-full)$/,
  connection_limit: /^\d{1,4}$/,
  pool_timeout: /^\d{1,4}$/,
  connect_timeout: /^\d{1,4}$/,
  schema: /^[a-z_][a-z0-9_]{0,62}$/,
};
/** A value containing any of these can smuggle a host or a second setting. Refused before the rule runs. */
const SCRATCH_VALUE_FORBIDDEN = /[@=;/,\s:]/;

export type ScratchCheck =
  | { readonly ok: true; readonly database: string }
  | { readonly ok: false; readonly reason: string };

export function checkScratchTarget(url: string, expectedName: string | undefined): ScratchCheck {
  const refuse = (reason: string): ScratchCheck => ({ ok: false, reason: `refused: ${reason}` });
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse('DATABASE_URL is not a URL');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    return refuse('the scheme is not postgres');
  }
  // A second '@' is refused outright (R8-3). This guard does not model a userinfo part that holds an '@',
  // so it does not vouch for the host of such a URL; refusing it is fail-closed. It is not a claim that
  // WHATWG and the driver read the host differently: for both shapes probed in review, Prisma read the host
  // after the last '@', as WHATWG does.
  if ((url.match(/@/g) ?? []).length > 1) {
    return refuse('the URL has more than one @');
  }
  // A fragment is not part of a connection string the guard can vouch for (R8-3).
  if (parsed.hash !== '') {
    return refuse('a fragment (#) is not allowed on the scratch target');
  }
  // A comma in the authority names a second host. Refuse before the host check.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*,/i.test(url)) {
    return refuse('the authority names more than one host');
  }
  for (const [key, value] of parsed.searchParams) {
    const name = key.toLowerCase();
    if (!SCRATCH_ALLOWED_QUERY_KEYS.includes(name)) {
      return refuse(`query parameter ${key} can change the connection target and is not allowed`);
    }
    if (SCRATCH_VALUE_FORBIDDEN.test(value)) {
      return refuse(`the value of ${key} contains a host, '@' or a separator, and is not allowed`);
    }
    const rule = SCRATCH_QUERY_VALUE_RULES[name];
    if (!rule || !rule.test(value)) {
      return refuse(`the value of ${key} is not an allowed value`);
    }
  }
  if (!SCRATCH_HOSTS.includes(parsed.hostname)) {
    return refuse(`host ${parsed.hostname} is not an allow-listed scratch host`);
  }
  const port = Number(parsed.port || '5432');
  if (!SCRATCH_PORTS.includes(port)) {
    return refuse(`port ${port} is not an allow-listed scratch port`);
  }
  // F3: a malformed percent-escape (%GZ, a lone %) makes decodeURIComponent throw. Refuse it, with a reason.
  let database: string;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    return refuse('the database name has a malformed percent-escape');
  }
  if (!SCRATCH_NAME_PATTERN.test(database)) {
    return refuse(`database ${database} does not match the scratch name shape`);
  }
  if (!expectedName) {
    return refuse(`${SCRATCH_NAME_ENV} is not set: name the scratch database this run expects`);
  }
  if (database !== expectedName) {
    return refuse(`database ${database} is not the one named by ${SCRATCH_NAME_ENV}`);
  }
  return { ok: true, database };
}
