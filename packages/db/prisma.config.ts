import { defineConfig } from 'prisma/config';

// Prisma CLI settings. Connection strings are read from DATABASE_URL (pooled, runtime) and
// DIRECT_URL (non-pooled, migrations) in the environment; see prisma/schema.prisma.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // Runs after `prisma migrate reset`. Reference data only (sectors and narratives).
    seed: 'tsx src/seed.ts',
  },
});
