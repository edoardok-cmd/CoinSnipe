import { describe, expect, it } from 'vitest';
import { Horizon, prisma } from './index';

describe('@coinsnipe/db entry point', () => {
  it('exports one PrismaClient singleton', async () => {
    // The generated client is a Proxy, so instanceof is not meaningful; check its surface.
    expect(typeof prisma.$connect).toBe('function');
    expect(typeof prisma.sector.findMany).toBe('function');
    const again = await import('./index');
    expect(again.prisma).toBe(prisma);
  });

  it('re-exports the generated enums', () => {
    expect(Object.values(Horizon)).toEqual(['short', 'medium', 'long']);
  });
});
