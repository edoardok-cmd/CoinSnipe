/**
 * @coinsnipe/db: the Prisma client singleton and every generated model type.
 *
 * Reads DATABASE_URL (pooled, runtime) from the environment. Migrations use DIRECT_URL
 * (see prisma/schema.prisma). The client connects lazily, so importing this module needs
 * no database.
 */
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { coinsnipePrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.coinsnipePrisma ?? new PrismaClient();

// Reuse one client across hot reloads in development; a serverless production process
// creates its own.
if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.coinsnipePrisma = prisma;
}

export * from '@prisma/client';
export { NARRATIVES, SECTORS } from './reference-data';
export type { ReferenceRow } from './reference-data';
