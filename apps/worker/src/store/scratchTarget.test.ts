import { describe, expect, it } from 'vitest';
import { checkScratchTarget } from './scratchTarget';

const NAME = 'coinsnipe_csn_024_impl_6115e476_test';
const GOOD = `postgresql://administrator@127.0.0.1:55432/${NAME}`;

describe('scratch target guard (R5-7, fail closed)', () => {
  it('accepts the scratch database this run names, on an allow-listed host and port', () => {
    expect(checkScratchTarget(GOOD, NAME)).toEqual({ ok: true, database: NAME });
    expect(checkScratchTarget(`postgres://localhost:5432/${NAME}`, NAME).ok).toBe(true);
  });

  it('refuses the shared test database name', () => {
    const shared = checkScratchTarget(
      'postgresql://administrator@127.0.0.1:55432/coinsnipe_test',
      NAME,
    );
    expect(shared.ok).toBe(false);
  });

  it('refuses a scratch-shaped name on a host that is not allow-listed', () => {
    const remote = checkScratchTarget(`postgresql://user@db.example.com:55432/${NAME}`, NAME);
    expect(remote.ok).toBe(false);
    expect(remote.ok ? '' : remote.reason).toContain('db.example.com');
  });

  it('refuses a scratch-shaped name on a port that is not allow-listed', () => {
    const other = checkScratchTarget(`postgresql://administrator@127.0.0.1:5433/${NAME}`, NAME);
    expect(other.ok).toBe(false);
  });

  it("refuses another session's scratch database: the name must equal the one this run names", () => {
    const otherSession = `postgresql://administrator@127.0.0.1:55432/coinsnipe_csn_024_review_0a1b2c3d_test`;
    const result = checkScratchTarget(otherSession, NAME);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('CSN024_SCRATCH_DB_NAME');
  });

  it('refuses when the expected name is not set', () => {
    expect(checkScratchTarget(GOOD, undefined).ok).toBe(false);
    expect(checkScratchTarget(GOOD, '').ok).toBe(false);
  });

  it('R6-2: refuses ?host= in the query, which Prisma would honour over the authority', () => {
    const result = checkScratchTarget(`${GOOD}?host=db.example.com`, NAME);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('host');
  });

  it('R6-2: refuses ?hostaddr= and any case variant of a host override', () => {
    expect(checkScratchTarget(`${GOOD}?hostaddr=10.0.0.1`, NAME).ok).toBe(false);
    expect(checkScratchTarget(`${GOOD}?HOST=db.example.com`, NAME).ok).toBe(false);
  });

  it('R6-2: refuses port and dbname overrides in the query, and unknown query keys', () => {
    expect(checkScratchTarget(`${GOOD}?port=5433`, NAME).ok).toBe(false);
    expect(checkScratchTarget(`${GOOD}?dbname=coinsnipe_test`, NAME).ok).toBe(false);
    expect(checkScratchTarget(`${GOOD}?anything=1`, NAME).ok).toBe(false);
  });

  it('R6-2 / R2-9: refuses a second host named in the authority, with that reason (the comma branch)', () => {
    // WHATWG parses this form (hostname "127.0.0.1,localhost"), so the comma branch is the one that refuses it.
    const result = checkScratchTarget(
      `postgresql://administrator@127.0.0.1,localhost:55432/${NAME}`,
      NAME,
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('more than one host');
  });

  it('R2-9: refuses a value that carries a host: sslmode=disable;host=db.example.com', () => {
    const result = checkScratchTarget(`${GOOD}?sslmode=disable;host=db.example.com`, NAME);
    expect(result.ok).toBe(false);
  });

  it('R2-9: refuses @ in a value: sslmode=require@db.example.com and connection_limit=5@evil', () => {
    expect(checkScratchTarget(`${GOOD}?sslmode=require@db.example.com`, NAME).ok).toBe(false);
    expect(checkScratchTarget(`${GOOD}?connection_limit=5@evil`, NAME).ok).toBe(false);
  });

  it('R2-9: refuses an sslmode value outside the allow-list, and accepts the allow-listed ones', () => {
    expect(checkScratchTarget(`${GOOD}?sslmode=bogus`, NAME).ok).toBe(false);
    expect(checkScratchTarget(`${GOOD}?sslmode=verify-full`, NAME).ok).toBe(true);
    expect(checkScratchTarget(`${GOOD}?sslmode=require`, NAME).ok).toBe(true);
  });

  it('R2-9: numeric keys accept digits only', () => {
    expect(checkScratchTarget(`${GOOD}?connection_limit=5`, NAME).ok).toBe(true);
    expect(checkScratchTarget(`${GOOD}?pool_timeout=30`, NAME).ok).toBe(true);
    expect(checkScratchTarget(`${GOOD}?connect_timeout=abc`, NAME).ok).toBe(false);
    expect(checkScratchTarget(`${GOOD}?connect_timeout=5;host=x`, NAME).ok).toBe(false);
  });

  it('R2-9: schema accepts an identifier and refuses @ or ;', () => {
    expect(checkScratchTarget(`${GOOD}?schema=public`, NAME).ok).toBe(true);
    expect(checkScratchTarget(`${GOOD}?schema=public@x`, NAME).ok).toBe(false);
    expect(checkScratchTarget(`${GOOD}?schema=public;host=x`, NAME).ok).toBe(false);
  });

  it('R6-2: accepts the connection-tuning keys (sslmode) as a control', () => {
    expect(checkScratchTarget(`${GOOD}?sslmode=disable`, NAME).ok).toBe(true);
  });

  it('refuses a value that is not a URL, and a non-postgres scheme', () => {
    expect(checkScratchTarget('not a url', NAME).ok).toBe(false);
    expect(checkScratchTarget(`mysql://127.0.0.1:55432/${NAME}`, NAME).ok).toBe(false);
  });
  // R8-3: alternate spellings. Each one is refused (or, for the controls, accepted) for a stated reason.
  it('R8-3: refuses a percent-encoded host key (%68ost), which decodes to host', () => {
    const r = checkScratchTarget(`${GOOD}?%68ost=db.example.com`, NAME);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toContain('host');
  });

  it('R8-3: refuses a repeated host key (host=x&host=db.example.com)', () => {
    expect(checkScratchTarget(`${GOOD}?host=x&host=db.example.com`, NAME).ok).toBe(false);
  });

  it('R8-3: refuses a trailing space on a key (sslmode%20) and on a value (disable%20)', () => {
    expect(checkScratchTarget(`${GOOD}?sslmode%20=disable`, NAME).ok).toBe(false);
    expect(checkScratchTarget(`${GOOD}?sslmode=disable%20`, NAME).ok).toBe(false);
  });

  it('R8-3: refuses a tab in a key (ssl%09mode) and in a value (disable%09)', () => {
    expect(checkScratchTarget(`${GOOD}?ssl%09mode=disable`, NAME).ok).toBe(false);
    expect(checkScratchTarget(`${GOOD}?sslmode=disable%09`, NAME).ok).toBe(false);
  });

  it('R8-3: refuses a leading question mark in a key (??host)', () => {
    const r = checkScratchTarget(`${GOOD}??host=db.example.com`, NAME);
    expect(r.ok).toBe(false);
  });

  it('R8-3: refuses an IPv6 literal host ([::1]) because it is not allow-listed', () => {
    const r = checkScratchTarget(`postgresql://administrator@[::1]:55432/${NAME}`, NAME);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toContain('[::1]');
  });

  it('R8-3: refuses a percent-encoded host (127%2E0%2E0%2E1) because it is not allow-listed', () => {
    const r = checkScratchTarget(`postgresql://administrator@127%2E0%2E0%2E1:55432/${NAME}`, NAME);
    expect(r.ok).toBe(false);
  });

  it('R8-3: refuses a fragment that carries a host (#?host=)', () => {
    const r = checkScratchTarget(`${GOOD}#?host=db.example.com`, NAME);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toContain('fragment');
  });

  it('R8-3: refuses userinfo with a second @ (user@evil@127.0.0.1)', () => {
    const r = checkScratchTarget(
      `postgresql://user@evil.example.com@127.0.0.1:55432/${NAME}`,
      NAME,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toContain('more than one @');
  });

  it('R8-3 control: an upper-case scheme and a user:password userinfo with one @ are accepted', () => {
    expect(checkScratchTarget(`POSTGRESQL://administrator@127.0.0.1:55432/${NAME}`, NAME).ok).toBe(
      true,
    );
    expect(checkScratchTarget(`postgresql://admin:secret@127.0.0.1:55432/${NAME}`, NAME).ok).toBe(
      true,
    );
  });

  it('F3: a malformed percent-escape in the database name is a refusal with a reason, not a throw', () => {
    for (const url of [
      'postgresql://administrator@127.0.0.1:55432/coinsnipe_csn_024_impl_%GZ_test',
      'postgresql://administrator@127.0.0.1:55432/coinsnipe_csn_024_impl_%E0_test',
      'postgresql://administrator@127.0.0.1:55432/%GZ',
    ]) {
      const result = checkScratchTarget(url, NAME);
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.reason).toContain('malformed percent-escape');
    }
  });

  it('F3: a malformed percent-escape in the host is refused, not thrown', () => {
    const result = checkScratchTarget(`postgresql://administrator@127.0.0.1%GZ:55432/${NAME}`, NAME);
    expect(result.ok).toBe(false);
  });

  it('F3 control: a well-formed percent-escape that decodes to the expected name is accepted', () => {
    const encoded = NAME.replace('_test', '%5Ftest');
    expect(checkScratchTarget(`postgresql://administrator@127.0.0.1:55432/${encoded}`, NAME)).toEqual({
      ok: true,
      database: NAME,
    });
  });
});
