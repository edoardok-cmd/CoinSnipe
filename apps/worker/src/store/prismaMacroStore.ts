/**
 * Prisma implementation of the fetchMacro store (CSN-024).
 *
 * - macro_daily, fear_greed_daily and gpr_monthly: INSERT ... ON CONFLICT on the table primary key,
 *   in chunks. Re-running the same day is an upsert, never a duplicate.
 * - events_calendar: replaceCalendarWindow runs in ONE transaction. It deletes the window rows of
 *   the kinds that succeeded, then inserts. Inserts use the two unique indexes explicitly:
 *   events_calendar_market_wide_key (date, kind, title) WHERE asset_id IS NULL for market-wide rows,
 *   and events_calendar_asset_id_date_kind_title_key for rows with an asset.
 *
 * Every statement is parameterised (Prisma.sql). No value is interpolated into SQL text.
 *
 * as_of rule contract (R5-6). macro_daily, fear_greed_daily, gpr_monthly and events_calendar have an
 * as_of (or fetch-date) column but no column that says which rule wrote the row. Rows are written
 * under the configured asOfRule: 'observation-date' by default (as_of = observation date), or
 * 'publication-lag' when opted in (as_of = observation date + lag). The entry logs the rule on every
 * run. Changing the rule between runs writes a second vintage for the same series and date (under
 * macro_daily's primary key (series_id, date, as_of)), and nothing on the row says which convention
 * produced it. Do not flip asOfRule without a backfill that rewrites the whole series. A schema column
 * for the rule is a db-engineer change and is not made here.
 */
import { Prisma, type PrismaClient } from '@coinsnipe/db';
import type {
  CalendarReplacement,
  CalendarWriteResult,
  FearGreedRecord,
  GprRecord,
  MacroDailyRecord,
  MacroStore,
} from '../jobs/fetchMacro';

/** Rows per INSERT. Keeps every statement well under Postgres' 65,535-parameter limit. */
export const STORE_CHUNK_ROWS = 1000;

function chunks<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size) as T[]);
  return out;
}

/** Keep the last row per key, so one INSERT never touches the same primary key twice. */
function dedupe<T>(rows: readonly T[], key: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(key(row), row);
  return [...byKey.values()];
}

export function createPrismaMacroStore(prisma: PrismaClient): MacroStore {
  return {
    async upsertMacroDaily(rows: readonly MacroDailyRecord[]): Promise<number> {
      const unique = dedupe(rows, (r) => `${r.seriesId}|${r.date}|${r.asOf}`);
      let affected = 0;
      for (const chunk of chunks(unique, STORE_CHUNK_ROWS)) {
        const values = Prisma.join(
          chunk.map(
            (r) =>
              Prisma.sql`(${r.seriesId}, ${r.date}::date, ${String(r.value)}::numeric, ${r.asOf}::date, ${r.source})`,
          ),
        );
        affected += await prisma.$executeRaw(Prisma.sql`
          INSERT INTO macro_daily (series_id, date, value, as_of, source)
          VALUES ${values}
          ON CONFLICT (series_id, date, as_of)
          DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, fetched_at = now()`);
      }
      return affected;
    },

    async upsertFearGreed(rows: readonly FearGreedRecord[]): Promise<number> {
      const unique = dedupe(rows, (r) => r.date);
      let affected = 0;
      for (const chunk of chunks(unique, STORE_CHUNK_ROWS)) {
        const values = Prisma.join(
          chunk.map(
            (r) =>
              Prisma.sql`(${r.date}::date, ${r.value}::integer, ${r.classification}, ${r.asOf}::date, ${r.source})`,
          ),
        );
        affected += await prisma.$executeRaw(Prisma.sql`
          INSERT INTO fear_greed_daily (date, value, classification, as_of, source)
          VALUES ${values}
          ON CONFLICT (date)
          DO UPDATE SET value = EXCLUDED.value, classification = EXCLUDED.classification,
                        as_of = EXCLUDED.as_of, source = EXCLUDED.source, fetched_at = now()`);
      }
      return affected;
    },

    async upsertGpr(rows: readonly GprRecord[]): Promise<number> {
      const unique = dedupe(rows, (r) => r.month);
      let affected = 0;
      for (const chunk of chunks(unique, STORE_CHUNK_ROWS)) {
        const values = Prisma.join(
          chunk.map(
            (r) =>
              Prisma.sql`(${r.month}::date, ${r.gpr}::double precision, ${r.asOf}::date, ${r.source})`,
          ),
        );
        affected += await prisma.$executeRaw(Prisma.sql`
          INSERT INTO gpr_monthly (month, gpr, as_of, source)
          VALUES ${values}
          ON CONFLICT (month)
          DO UPDATE SET gpr = EXCLUDED.gpr, as_of = EXCLUDED.as_of, source = EXCLUDED.source,
                        fetched_at = now()`);
      }
      return affected;
    },

    async replaceCalendarWindow(input: CalendarReplacement): Promise<CalendarWriteResult> {
      const { from, to, kinds, rows } = input;
      if (kinds.length === 0) return { written: 0, warnings: [] };
      const kindList = Prisma.join(kinds);
      const marketWide = rows.filter((r) => r.assetId === null);

      return prisma.$transaction(async (tx) => {
        // R6-7: an asset id that is not in the assets table skips only its own rows, with a warning naming
        // the id. Checked inside the transaction, before any insert, so the foreign key cannot fail the write.
        const assetIds = [...new Set(rows.flatMap((r) => (r.assetId === null ? [] : [r.assetId])))];
        const known = new Set<string>();
        if (assetIds.length > 0) {
          const found = await tx.asset.findMany({
            where: { id: { in: assetIds } },
            select: { id: true },
          });
          for (const row of found) known.add(row.id);
        }
        const warnings: string[] = [];
        const withAsset = rows.filter((r) => r.assetId !== null && known.has(r.assetId));
        for (const id of assetIds.filter((id) => !known.has(id))) {
          const skipped = rows.filter((r) => r.assetId === id).length;
          warnings.push(
            `calendar: asset id "${id}" is not in the assets table; ${skipped} row(s) skipped, the other rows written`,
          );
        }

        // 1. Remove the window rows of the kinds that succeeded. Other kinds are never touched.
        await tx.$executeRaw(Prisma.sql`
          DELETE FROM events_calendar
          WHERE date >= ${from}::date AND date <= ${to}::date
            AND kind::text IN (${kindList})`);

        let inserted = 0;
        // 2. Market-wide rows (asset_id IS NULL): conflict target is the partial unique index.
        for (const chunk of chunks(
          dedupe(marketWide, (r) => `${r.date}|${r.kind}|${r.title}`),
          STORE_CHUNK_ROWS,
        )) {
          const values = Prisma.join(
            chunk.map(
              (r) =>
                Prisma.sql`(${r.date}::date, ${r.kind}::calendar_event_kind, ${r.title}, NULL, ${r.asOf}::date, ${r.source})`,
            ),
          );
          inserted += await tx.$executeRaw(Prisma.sql`
            INSERT INTO events_calendar (date, kind, title, asset_id, as_of, source)
            VALUES ${values}
            ON CONFLICT (date, kind, title) WHERE asset_id IS NULL
            DO UPDATE SET as_of = EXCLUDED.as_of, source = EXCLUDED.source, fetched_at = now()`);
        }
        // 3. Rows with an asset: conflict target is the (asset_id, date, kind, title) unique key.
        for (const chunk of chunks(
          dedupe(withAsset, (r) => `${r.assetId}|${r.date}|${r.kind}|${r.title}`),
          STORE_CHUNK_ROWS,
        )) {
          const values = Prisma.join(
            chunk.map(
              (r) =>
                Prisma.sql`(${r.date}::date, ${r.kind}::calendar_event_kind, ${r.title}, ${r.assetId}, ${r.asOf}::date, ${r.source})`,
            ),
          );
          inserted += await tx.$executeRaw(Prisma.sql`
            INSERT INTO events_calendar (date, kind, title, asset_id, as_of, source)
            VALUES ${values}
            ON CONFLICT (asset_id, date, kind, title)
            DO UPDATE SET as_of = EXCLUDED.as_of, source = EXCLUDED.source, fetched_at = now()`);
        }
        return { written: inserted, warnings };
      });
    },
  };
}
