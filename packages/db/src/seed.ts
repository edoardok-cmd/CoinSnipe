/**
 * Seeds the reference tables: 11 sectors and 20 narratives. Nothing else.
 *
 * Idempotent: every row is an upsert keyed on its id, so running it twice leaves the same
 * rows. It writes NO price, score, asset or user data. The sample coin universe is a test
 * fixture and is never loaded into a real database.
 *
 * Run: `pnpm -F @coinsnipe/db db:seed` with DATABASE_URL set, in the environment or in
 * .env.local / .env (see load-env.ts). Required once per environment after
 * `prisma migrate deploy`: assets.sector_id is a foreign key to sectors, and no migration
 * inserts the sectors.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { loadPackageEnv } from './load-env';
import { NARRATIVES, SECTORS } from './reference-data';

export interface SeedResult {
  readonly sectors: number;
  readonly narratives: number;
}

export async function seedReferenceData(prisma: PrismaClient): Promise<SeedResult> {
  await prisma.$transaction([
    ...SECTORS.map((row, index) =>
      prisma.sector.upsert({
        where: { id: row.id },
        create: { id: row.id, name: row.name, description: row.description, sortOrder: index },
        update: { name: row.name, description: row.description, sortOrder: index },
      }),
    ),
    ...NARRATIVES.map((row, index) =>
      prisma.narrative.upsert({
        where: { id: row.id },
        create: { id: row.id, name: row.name, description: row.description, sortOrder: index },
        update: { name: row.name, description: row.description, sortOrder: index },
      }),
    ),
  ]);
  return { sectors: SECTORS.length, narratives: NARRATIVES.length };
}

async function main(): Promise<void> {
  // Only when run as a script: importing this module (tests) must not read env files.
  loadPackageEnv(fileURLToPath(new URL('..', import.meta.url)));
  const prisma = new PrismaClient();
  try {
    const result = await seedReferenceData(prisma);
    console.log(`Seeded ${result.sectors} sectors and ${result.narratives} narratives.`);
  } finally {
    await prisma.$disconnect();
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
