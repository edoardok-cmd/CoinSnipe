/**
 * Entry for the daily macro job (CSN-024). Runs the composition root in ./jobs/fetchMacro with the
 * real Prisma client and the process environment, loads the ETF admin file, prints a summary, and
 * exits 1 when any source failed.
 *
 * Run (needs DATABASE_URL and FRED_API_KEY; optionally COINGECKO_API_KEY, COINGECKO_PLAN and
 * COINSNIPE_ETF_DECISIONS_PATH):
 *   pnpm --filter @coinsnipe/worker exec tsx src/run-fetch-macro.ts
 */
import { MACRO_CONFIG_DEFAULTS } from '@coinsnipe/data';
import { prisma } from '@coinsnipe/db';
import { loadEtfDecisions } from './config/etfDecisions';
import { runFetchMacroJob } from './jobs/fetchMacro';

const etfDecisions = loadEtfDecisions(process.env);

const report = await runFetchMacroJob({
  prisma,
  env: process.env,
  etfDecisions,
  log: (line) => console.log(line),
});

console.log(
  JSON.stringify({
    job: report.job,
    today: report.today,
    ok: report.ok,
    // R5-6: macro_daily does not store which as_of rule wrote a row. The run records it here.
    asOfRule: MACRO_CONFIG_DEFAULTS.asOfRule,
    etfDecisions: etfDecisions.path ?? 'not configured',
    sources: report.sources.map((s) => ({ name: s.name, status: s.status, written: s.written })),
  }),
);

await prisma.$disconnect();
process.exitCode = report.ok ? 0 : 1;
