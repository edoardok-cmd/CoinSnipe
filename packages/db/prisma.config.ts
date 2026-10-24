import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';
import { loadPackageEnv } from './src/load-env';

// A prisma.config.ts makes the Prisma CLI skip its own .env loading, so load .env.local and
// .env here (never overriding variables already in the environment, never printing values).
loadPackageEnv(fileURLToPath(new URL('.', import.meta.url)));

// Prisma CLI settings. Connection strings are read from DATABASE_URL (pooled, runtime) and
// DIRECT_URL (non-pooled, migrations) in the environment; see prisma/schema.prisma.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // Runs after `prisma migrate reset`. Reference data only (sectors and narratives).
    // `migrate deploy` never runs it, and `migrate dev` runs it only when it creates or resets the
    // database: run `pnpm db:seed` explicitly in every environment (idempotent).
    seed: 'tsx src/seed.ts',
  },
});
