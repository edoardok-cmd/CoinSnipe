import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Structural guards for .github/workflows/ci.yml. Static checks only: they parse the
// workflow, they do not run it. Each one fails if the property it pins is reverted.

const workflow = parse(
  readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
);
const jobs = Object.entries(workflow.jobs ?? {});
const stepsOf = (job) => job.steps ?? [];

// The secret-scan job is the one that mentions gitleaks in any step.
const scanJobs = jobs.filter(([, job]) =>
  stepsOf(job).some((step) => `${step.uses ?? ''}\n${step.run ?? ''}`.includes('gitleaks')),
);

const GITLEAKS_GIT = /gitleaks["']?\s+git(\s|$)/;
const RANGE_LIMITING_FLAGS = [
  '--log-opts',
  '--no-git',
  '--since',
  '--until',
  '--staged',
  '--pre-commit',
];

describe('ci.yml secret scan covers full history', () => {
  it('has exactly one job that runs gitleaks', () => {
    expect(scanJobs).toHaveLength(1);
  });

  it('does not use the range-limited gitleaks action', () => {
    for (const [, job] of scanJobs) {
      for (const step of stepsOf(job)) {
        expect(step.uses ?? '').not.toMatch(/gitleaks-action/);
      }
    }
  });

  it('checks out with fetch-depth 0', () => {
    const [[, job]] = scanJobs;
    const checkout = stepsOf(job).find((step) => (step.uses ?? '').startsWith('actions/checkout@'));
    expect(checkout, 'scan job has a checkout step').toBeDefined();
    expect(checkout.with?.['fetch-depth']).toBe(0);
  });

  it('runs `gitleaks git` with no range-limiting flag and cannot be skipped', () => {
    const [[, job]] = scanJobs;
    const scan = stepsOf(job).find((step) => GITLEAKS_GIT.test(step.run ?? ''));
    expect(scan, 'a step runs `gitleaks git`').toBeDefined();
    for (const flag of RANGE_LIMITING_FLAGS) {
      expect(scan.run).not.toContain(flag);
    }
    expect(scan['continue-on-error']).toBeFalsy();
    expect(scan.run).not.toMatch(/\|\|\s*(true|:)/);
    expect(job['continue-on-error']).toBeFalsy();
    expect(job.if).toBeUndefined();
  });
});

describe('ci.yml pinned gitleaks download is checksum-verified before use', () => {
  const [[, job]] = scanJobs;
  const steps = stepsOf(job);
  const install = steps.find(
    (step) => /curl|wget/.test(step.run ?? '') && /gitleaks/.test(step.run ?? ''),
  );
  const scanIndex = steps.findIndex((step) => GITLEAKS_GIT.test(step.run ?? ''));

  it('has a download step that runs before the scan step', () => {
    expect(install, 'a step downloads gitleaks').toBeDefined();
    expect(steps.indexOf(install)).toBeLessThan(scanIndex);
  });

  it('pins an exact version and a 64-hex SHA-256', () => {
    expect(install.env?.GITLEAKS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(install.env?.GITLEAKS_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies the archive against that SHA-256 after downloading and before extracting', () => {
    const run = install.run;
    const download = run.search(/curl|wget/);
    const verify = run.search(/sha256sum\s+(--check|-c)|shasum\s+-a\s+256\s+(--check|-c)/);
    const extract = run.search(/tar\s+-?x/);
    expect(verify, 'a checksum verification command exists').toBeGreaterThan(-1);
    expect(run).toContain('${GITLEAKS_SHA256}');
    expect(download).toBeLessThan(verify);
    expect(verify).toBeLessThan(extract);
  });

  it('fails the step when verification fails', () => {
    expect(install.run).toMatch(/set\s+-[a-z]*e[a-z]*/);
    expect(install.run).not.toMatch(/sha256sum[^\n]*\|\|\s*(true|:)/);
    expect(install['continue-on-error']).toBeFalsy();
  });
});

describe('ci.yml concurrency never cancels push runs', () => {
  const PR_ONLY = /^\$\{\{\s*github\.event_name\s*==\s*'pull_request'\s*\}\}$/;
  const acceptable = (value) =>
    value === undefined || value === false || PR_ONLY.test(String(value));

  it('workflow-level cancel-in-progress is not unconditionally true', () => {
    expect(acceptable(workflow.concurrency?.['cancel-in-progress'])).toBe(true);
  });

  it('no job overrides concurrency with an unconditional cancel', () => {
    for (const [, job] of jobs) {
      expect(acceptable(job.concurrency?.['cancel-in-progress'])).toBe(true);
    }
  });
});
