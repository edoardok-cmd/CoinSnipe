/**
 * F4: the db scripts must read .env.local and .env. Needs no database.
 *
 * Unit tests cover the loader (priority, no override, no value output). The process tests
 * copy the real prisma.config.ts, seed.ts and loader into a throwaway tree, put a file with
 * PLACEHOLDER values at its "repo root", and run the real Prisma CLI and the real seed
 * script with DATABASE_URL and DIRECT_URL removed from the environment. They fail if the
 * config or the seed stops loading the files. No real secret is used or needed.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { envFilesFor, loadEnvFiles } from './load-env';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const PLACEHOLDER_SECRET = 'csn_placeholder_pw';
const PLACEHOLDER_URL = `postgresql://csn_user:${PLACEHOLDER_SECRET}@127.0.0.1:1/csn_db`;
const TEST_KEYS = ['CSN_ENVTEST_A', 'CSN_ENVTEST_B', 'CSN_ENVTEST_C', 'CSN_ENVTEST_D'];

describe('loadEnvFiles', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'csn-env-unit-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    for (const key of TEST_KEYS) delete process.env[key];
    vi.restoreAllMocks();
  });

  it('lists package .env.local, root .env.local, package .env, root .env, in that order', () => {
    const files = envFilesFor('/repo/packages/db');
    expect(files).toEqual([
      '/repo/packages/db/.env.local',
      '/repo/.env.local',
      '/repo/packages/db/.env',
      '/repo/.env',
    ]);
  });

  it('loads .env.local before .env and skips missing files', () => {
    const local = join(dir, 'a.env.local');
    const shared = join(dir, 'a.env');
    writeFileSync(local, 'CSN_ENVTEST_A=from_local\nCSN_ENVTEST_B="quoted value"\n');
    writeFileSync(shared, 'CSN_ENVTEST_A=from_shared\nCSN_ENVTEST_C=only_shared\n');
    const loaded = loadEnvFiles([join(dir, 'missing.env'), local, shared]);
    expect(loaded).toEqual([local, shared]);
    expect(process.env['CSN_ENVTEST_A']).toBe('from_local');
    expect(process.env['CSN_ENVTEST_B']).toBe('quoted value');
    expect(process.env['CSN_ENVTEST_C']).toBe('only_shared');
  });

  it('never overrides a variable that is already in the environment', () => {
    process.env['CSN_ENVTEST_D'] = 'from_shell';
    const file = join(dir, 'b.env');
    writeFileSync(file, 'CSN_ENVTEST_D=from_file\n');
    loadEnvFiles([file]);
    expect(process.env['CSN_ENVTEST_D']).toBe('from_shell');
  });

  it('returns and prints paths only, never values', () => {
    const file = join(dir, 'c.env');
    writeFileSync(file, `CSN_ENVTEST_A=${PLACEHOLDER_SECRET}\n`);
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');
    const log = vi.spyOn(console, 'log');
    const loaded = loadEnvFiles([file]);
    expect(JSON.stringify(loaded)).not.toContain(PLACEHOLDER_SECRET);
    const printed = [...out.mock.calls, ...err.mock.calls, ...log.mock.calls].flat().join('');
    expect(printed).not.toContain(PLACEHOLDER_SECRET);
  });
});

describe('the real prisma.config.ts and seed load the env files (process level)', () => {
  let root: string;
  let pkg: string;

  /** Environment without any database variable, so only the files can supply them. */
  const cleanEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    delete env['DATABASE_URL'];
    delete env['DIRECT_URL'];
    return env;
  };
  const run = (bin: string, args: string[]) =>
    spawnSync(join(pkg, 'node_modules', '.bin', bin), args, {
      cwd: pkg,
      env: cleanEnv(),
      encoding: 'utf8',
      timeout: 90_000,
    });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'csn-env-tree-'));
    pkg = join(root, 'packages', 'db');
    mkdirSync(join(pkg, 'src'), { recursive: true });
    mkdirSync(join(pkg, 'prisma'));
    // Byte-for-byte copies of the real files under test.
    cpSync(join(packageDir, 'prisma.config.ts'), join(pkg, 'prisma.config.ts'));
    cpSync(join(packageDir, 'prisma', 'schema.prisma'), join(pkg, 'prisma', 'schema.prisma'));
    for (const file of ['load-env.ts', 'seed.ts', 'reference-data.ts']) {
      cpSync(join(packageDir, 'src', file), join(pkg, 'src', file));
    }
    writeFileSync(join(pkg, 'package.json'), '{"type":"module"}');
    symlinkSync(join(packageDir, 'node_modules'), join(pkg, 'node_modules'));
  }, 60_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const name of ['.env.local', '.env']) {
      rmSync(join(root, name), { force: true });
      rmSync(join(pkg, name), { force: true });
    }
  });

  it('control: without any env file the Prisma CLI reports the missing variable', () => {
    const result = run('prisma', ['validate']);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('Environment variable not found');
  }, 90_000);

  it('prisma validate succeeds when only the repo-root .env.local supplies the URLs', () => {
    writeFileSync(
      join(root, '.env.local'),
      `DATABASE_URL=${PLACEHOLDER_URL}\nDIRECT_URL=${PLACEHOLDER_URL}\n`,
    );
    const result = run('prisma', ['validate']);
    expect(`${result.stdout}${result.stderr}`).toContain('is valid');
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(PLACEHOLDER_SECRET);
  }, 90_000);

  it('prisma validate also reads a plain .env in packages/db', () => {
    writeFileSync(
      join(pkg, '.env'),
      `DATABASE_URL=${PLACEHOLDER_URL}\nDIRECT_URL=${PLACEHOLDER_URL}\n`,
    );
    const result = run('prisma', ['validate']);
    expect(result.status).toBe(0);
  }, 90_000);

  it('the seed script reads .env.local: it reaches the connection step, not the env error', () => {
    writeFileSync(
      join(root, '.env.local'),
      `DATABASE_URL=${PLACEHOLDER_URL}\nDIRECT_URL=${PLACEHOLDER_URL}\n`,
    );
    const result = run('tsx', ['src/seed.ts']);
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0); // port 1 refuses the connection
    expect(output).not.toContain('Environment variable not found');
    expect(output).toContain("Can't reach database server");
    expect(output).not.toContain(PLACEHOLDER_SECRET);
  }, 90_000);

  it('control: the seed script without an env file reports the missing variable', () => {
    const result = run('tsx', ['src/seed.ts']);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('Environment variable not found');
  }, 90_000);

  it('uses a tree that really contains the files under test', () => {
    expect(existsSync(join(pkg, 'prisma.config.ts'))).toBe(true);
    expect(existsSync(join(pkg, 'src', 'load-env.ts'))).toBe(true);
  });
});
