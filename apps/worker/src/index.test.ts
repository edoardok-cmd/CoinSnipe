import { describe, expect, it } from 'vitest';
import { WORKER_NAME } from './index';
import { run } from './jobs/placeholder';

describe('@coinsnipe/worker', () => {
  it('exports its name', () => {
    expect(WORKER_NAME).toBe('@coinsnipe/worker');
  });

  it('runs the placeholder job', async () => {
    await expect(run()).resolves.toBeUndefined();
  });
});
