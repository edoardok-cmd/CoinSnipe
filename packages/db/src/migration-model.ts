/**
 * Test support, not part of the package API (index.ts does not export it).
 *
 * Replays the committed migration SQL into a small model of the schema (tables, columns,
 * indexes, foreign keys) and applies the index rules the product needs. The same rules run
 * over the live catalogue of a migrated database in database.test.ts, so a dropped index
 * fails whether the SQL or the database is what changed.
 *
 * The parser reads the statement shapes Prisma emits plus the hand-written ones used in
 * 0002 (DROP INDEX, ADD COLUMN, DROP COLUMN, DROP TABLE). It does not execute anything.
 */

export interface IndexInfo {
  readonly name: string;
  readonly table: string;
  /** Ordered key columns. */
  readonly columns: readonly string[];
  readonly unique: boolean;
  /** True for a partial index (WHERE clause): it serves only part of the table. */
  readonly partial: boolean;
  /** Access method: btree for primary keys, plain and unique indexes; gin for arrays. */
  readonly method: string;
}

export interface ForeignKeyInfo {
  readonly name: string;
  readonly table: string;
  readonly columns: readonly string[];
}

export interface SchemaModel {
  readonly tables: Map<string, Set<string>>;
  readonly indexes: IndexInfo[];
  readonly foreignKeys: ForeignKeyInfo[];
}

/** Columns that carry the day, week, month or hour a daily-style row describes. */
export const DATE_KEY_COLUMNS: readonly string[] = [
  'date',
  'week_start',
  'month',
  'ts',
  'run_date',
];

function stripComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

function columnList(raw: string): string[] {
  return [...raw.matchAll(/"(\w+)"/g)].map((match) => match[1] as string);
}

export function replayMigrations(sqlFiles: readonly string[]): SchemaModel {
  const tables = new Map<string, Set<string>>();
  let indexes: IndexInfo[] = [];
  let foreignKeys: ForeignKeyInfo[] = [];

  for (const file of sqlFiles) {
    const statements = stripComments(file)
      .split(/;\s*(?:\n|$)/)
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);

    for (const statement of statements) {
      const createTable = /^CREATE TABLE "(\w+)" \(([\s\S]*)\)$/.exec(statement);
      if (createTable !== null) {
        const table = createTable[1] as string;
        const columns = new Set<string>();
        for (const line of (createTable[2] as string).split('\n')) {
          const column = /^\s+"(\w+)"\s+\S/.exec(line);
          if (column !== null) columns.add(column[1] as string);
          const pk = /CONSTRAINT "(\w+)" PRIMARY KEY \(([^)]*)\)/.exec(line);
          if (pk !== null) {
            indexes.push({
              name: pk[1] as string,
              table,
              columns: columnList(pk[2] as string),
              unique: true,
              partial: false,
              method: 'btree',
            });
          }
        }
        tables.set(table, columns);
        continue;
      }

      const createIndex =
        /^CREATE (UNIQUE )?INDEX "(\w+)" ON "(\w+)"\s*(?:USING (\w+)\s*)?\(([^)]*)\)\s*(WHERE [\s\S]*)?$/i.exec(
          statement,
        );
      if (createIndex !== null) {
        indexes.push({
          name: createIndex[2] as string,
          table: createIndex[3] as string,
          columns: columnList(createIndex[5] as string),
          unique: createIndex[1] !== undefined,
          partial: createIndex[6] !== undefined,
          method: (createIndex[4] ?? 'btree').toLowerCase(),
        });
        continue;
      }

      const dropIndex = /^DROP INDEX "(\w+)"$/.exec(statement);
      if (dropIndex !== null) {
        indexes = indexes.filter((index) => index.name !== dropIndex[1]);
        continue;
      }

      const dropTable = /^DROP TABLE "(\w+)"$/.exec(statement);
      if (dropTable !== null) {
        tables.delete(dropTable[1] as string);
        indexes = indexes.filter((index) => index.table !== dropTable[1]);
        foreignKeys = foreignKeys.filter((fk) => fk.table !== dropTable[1]);
        continue;
      }

      const alter = /^ALTER TABLE "(\w+)"([\s\S]*)$/.exec(statement);
      if (alter !== null) {
        const table = alter[1] as string;
        const body = alter[2] as string;
        const fk = /ADD CONSTRAINT "(\w+)" FOREIGN KEY \(([^)]*)\)/.exec(body);
        if (fk !== null) {
          foreignKeys.push({
            name: fk[1] as string,
            table,
            columns: columnList(fk[2] as string),
          });
          continue;
        }
        for (const added of body.matchAll(/ADD COLUMN\s+"(\w+)"/g)) {
          tables.get(table)?.add(added[1] as string);
        }
        for (const dropped of body.matchAll(/DROP COLUMN\s+"(\w+)"/g)) {
          const column = dropped[1] as string;
          tables.get(table)?.delete(column);
          // Postgres drops every index that includes a dropped column.
          indexes = indexes.filter(
            (index) => !(index.table === table && index.columns.includes(column)),
          );
          foreignKeys = foreignKeys.filter(
            (key) => !(key.table === table && key.columns.includes(column)),
          );
        }
      }
    }
  }
  return { tables, indexes, foreignKeys };
}

/** A whole-table btree index that can serve a lookup on its leading columns. */
function serving(index: IndexInfo): boolean {
  return index.method === 'btree' && !index.partial;
}

function hasLeadingColumns(model: SchemaModel, table: string, leading: readonly string[]): boolean {
  return model.indexes.some(
    (index) =>
      index.table === table &&
      serving(index) &&
      leading.every((column, position) => index.columns[position] === column),
  );
}

/**
 * The index rules from the CSN-003 task description, returned as readable violations:
 * - every table with a date-like key column (DATE_KEY_COLUMNS) has an index leading with it;
 * - every table with asset_id and date has an index leading with (asset_id, date);
 * - every table with user_id has an index leading with user_id;
 * - every foreign key has an index leading with its columns (cheap parent deletes and joins).
 * Partial indexes and non-btree indexes do not count.
 */
export function indexRuleViolations(model: SchemaModel): string[] {
  const violations: string[] = [];
  for (const [table, columns] of [...model.tables].sort(([a], [b]) => a.localeCompare(b))) {
    for (const column of DATE_KEY_COLUMNS) {
      if (columns.has(column) && !hasLeadingColumns(model, table, [column])) {
        violations.push(`${table}: no index leads with (${column})`);
      }
    }
    if (columns.has('asset_id') && columns.has('date')) {
      if (!hasLeadingColumns(model, table, ['asset_id', 'date'])) {
        violations.push(`${table}: no index leads with (asset_id, date)`);
      }
    }
    if (columns.has('user_id') && !hasLeadingColumns(model, table, ['user_id'])) {
      violations.push(`${table}: no index leads with (user_id)`);
    }
  }
  for (const fk of model.foreignKeys) {
    if (!hasLeadingColumns(model, fk.table, fk.columns)) {
      violations.push(`${fk.table}: foreign key ${fk.name} has no index leading with it`);
    }
  }
  return violations;
}

/** Tables that have a column named `column`. */
export function tablesWithColumn(model: SchemaModel, column: string): string[] {
  return [...model.tables].filter(([, columns]) => columns.has(column)).map(([table]) => table);
}
