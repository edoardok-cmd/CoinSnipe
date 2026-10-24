/**
 * Loads .env.local and .env for the database scripts (prisma.config.ts and the seed).
 *
 * Prisma skips its own .env loading when a prisma.config.ts exists, and `tsx src/seed.ts`
 * never loaded any, so DATABASE_URL and DIRECT_URL set in the file `.env.example` tells
 * developers to create (.env.local) were ignored. This module restores that.
 *
 * Rules:
 * - Variables already in the environment always win: process.loadEnvFile never overwrites
 *   an existing variable, and the files are read highest priority first.
 * - Priority, highest first: packages/db/.env.local, repo root .env.local, packages/db/.env,
 *   repo root .env. A missing file is skipped.
 * - It never prints values. It returns the paths of the files it loaded, nothing else.
 *
 * Not exported from index.ts: the runtime client reads the environment of its host and
 * must not read files.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The env files for a package directory, highest priority first. */
export function envFilesFor(packageDir: string): string[] {
  const repoRoot = resolve(packageDir, '..', '..');
  return [
    join(packageDir, '.env.local'),
    join(repoRoot, '.env.local'),
    join(packageDir, '.env'),
    join(repoRoot, '.env'),
  ];
}

/** Load each existing file without overriding variables that are already set. */
export function loadEnvFiles(files: readonly string[]): string[] {
  const loaded: string[] = [];
  for (const file of files) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
      loaded.push(file);
    }
  }
  return loaded;
}

/** Convenience for the two callers: load the env files of the db package. */
export function loadPackageEnv(packageDir: string): string[] {
  return loadEnvFiles(envFilesFor(packageDir));
}
