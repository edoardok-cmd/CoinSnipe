/**
 * Geopolitical Risk (GPR) index, Caldara and Iacoviello (master plan A9, the war, sanctions and
 * conflict half of News risk). Monthly data file: matteoiacoviello.com/gpr.htm.
 *
 * Licence: CC BY. Cite the paper and the download date wherever the index is shown (see
 * GPR_CITATION and packages/data/docs/macro-sentiment-methodology.md).
 *
 * The workbook is a legacy .xls. `fetchGprMonthly` downloads it and parses it with the default
 * reader, readXlsWorkbookRows (SheetJS xlsx, declared in packages/data/package.json). A caller may
 * inject `readWorkbook` instead (tests, or another parser). parseGprWorkbookRows reads the row
 * matrix that any reader returns.
 */
import {
  asOfFor,
  type AsOfSetting,
  asOfSettingFor,
  DAY_MS,
  fetchOk,
  type FetchLike,
  SourceError,
} from './shared';
import { asOfSettingFrom, MACRO_CONFIG_DEFAULTS, type MacroSourceConfig } from './fred';
import * as XLSX from 'xlsx';

export const GPR_SOURCE = 'matteoiacoviello.com';
export const GPR_PAGE_URL = 'https://www.matteoiacoviello.com/gpr.htm';
export const GPR_XLS_URL = 'https://www.matteoiacoviello.com/gpr_files/data_gpr_export.xls';
/** A9 reads the GPR index against a baseline of 100. */
export const GPR_BASELINE = 100;
/** Excel serial of 9999-12-31 in the 1900 system: the last serial with a 4-digit year (R3-5). */
export const MAX_EXCEL_SERIAL_YEAR_9999 = 2_958_465;
export const GPR_CITATION =
  'Caldara, Dario and Matteo Iacoviello (2022), "Measuring Geopolitical Risk," American Economic Review 112(4), 1194-1225. Data from matteoiacoviello.com/gpr.htm (CC BY), downloaded on the date shown.';

export type GprCell = string | number | boolean | Date | null | undefined;
/** Row matrix as returned by an XLS reader. Row 0 holds the headers. */
export type GprRowMatrix = readonly (readonly GprCell[])[];

export interface GprMonthlyRow {
  /** First day of the month the reading describes, YYYY-MM-01. */
  readonly month: string;
  readonly gpr: number;
  /** as_of under the D1 rule: the month itself (default, observation-date), or first of the month + 45 days (publication-lag). */
  readonly asOf: string;
  readonly source: string;
}

/**
 * Excel 1900-system serial to a UTC date. Serial 1 is 1900-01-01 and serial 32 is 1900-02-01.
 * Serials from 61 on (1900-03-01) carry Excel's phantom 1900-02-29, so the base shifts by one day.
 */
export function excelSerialToIsoDate(serial: number): string {
  if (!Number.isFinite(serial) || serial < 1 || serial > MAX_EXCEL_SERIAL_YEAR_9999) {
    throw new SourceError(GPR_SOURCE, 'Excel serial is outside the years 0000 to 9999');
  }
  const base = serial < 61 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  return new Date(base + Math.floor(serial) * DAY_MS).toISOString().slice(0, 10);
}

function monthStartFromCell(cell: GprCell): string | null {
  // R3-5: serials and Date cells must stay within years 0000 to 9999. Anything else is an
  // unreadable month (a typed SourceError from the parser), never a malformed date string.
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell) || cell < 1 || cell > MAX_EXCEL_SERIAL_YEAR_9999) return null;
    return `${excelSerialToIsoDate(cell).slice(0, 7)}-01`;
  }
  if (cell instanceof Date) {
    if (Number.isNaN(cell.getTime())) return null;
    const year = cell.getUTCFullYear();
    if (year < 0 || year > 9999) return null;
    // F10: reader contract is UTC midnight, so UTC getters give the same month in every TZ.
    const month = String(cell.getUTCMonth() + 1).padStart(2, '0');
    return `${String(year).padStart(4, '0')}-${month}-01`;
  }
  if (typeof cell === 'string') {
    // F9: months 1 to 12 only.
    const iso = /^(\d{4})-(0?[1-9]|1[0-2])(?:-\d{1,2})?$/.exec(cell.trim());
    if (iso) return `${iso[1]}-${iso[2]!.padStart(2, '0')}-01`;
    const compact = /^(\d{4})M(0?[1-9]|1[0-2])$/i.exec(cell.trim());
    if (compact) return `${compact[1]}-${compact[2]!.padStart(2, '0')}-01`;
  }
  return null;
}

function isBlank(cell: GprCell): boolean {
  return cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '');
}

/**
 * Pick the GPR column from the workbook matrix. Months are read from the `month` column.
 * Rows with an empty GPR cell are skipped: the file leaves GPR blank before 1985 (only the
 * historical GPRH columns have values earlier). A non-blank row with an unreadable month or
 * GPR value is an error, not a silent skip.
 */
export function parseGprWorkbookRows(
  rows: GprRowMatrix,
  asOfSetting: AsOfSetting = asOfSettingFor('GPR_MONTHLY'),
): GprMonthlyRow[] {
  const header = rows[0];
  if (!header) throw new SourceError(GPR_SOURCE, 'workbook has no header row');
  const monthIndex = header.findIndex(
    (h) => typeof h === 'string' && h.trim().toLowerCase() === 'month',
  );
  const gprIndex = header.findIndex((h) => typeof h === 'string' && h.trim() === 'GPR');
  if (monthIndex < 0 || gprIndex < 0) {
    throw new SourceError(GPR_SOURCE, 'workbook is missing the month or GPR column');
  }

  const byMonth = new Map<string, GprMonthlyRow>();
  for (const row of rows.slice(1)) {
    const monthCell = row[monthIndex];
    const gprCell = row[gprIndex];
    if (isBlank(gprCell)) continue;
    const month = monthStartFromCell(monthCell ?? null);
    if (!month) throw new SourceError(GPR_SOURCE, 'a GPR row has an unreadable month');
    const gpr = typeof gprCell === 'number' ? gprCell : Number(gprCell);
    if (typeof gprCell === 'boolean' || !Number.isFinite(gpr)) {
      throw new SourceError(GPR_SOURCE, `GPR value for ${month} is not numeric`);
    }
    const asOf = asOfFor(month, asOfSetting.lagDays, asOfSetting.rule);
    byMonth.set(month, { month, gpr, asOf, source: GPR_SOURCE });
  }
  return [...byMonth.values()].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

/** A9 input: GPR points above (+) or below (-) the baseline of 100. */
export function gprVsBaseline(gpr: number): number {
  return gpr - GPR_BASELINE;
}

/**
 * Default XLS reader (SheetJS xlsx 0.20.3, Apache-2.0). Reads the first sheet as a row matrix.
 * Date cells are returned as Excel serials (cellDates off), which parseGprWorkbookRows reads.
 */
export function readXlsWorkbookRows(bytes: Uint8Array): GprRowMatrix {
  const workbook = XLSX.read(bytes, { type: 'array', cellDates: false });
  const firstName = workbook.SheetNames[0];
  const sheet = firstName === undefined ? undefined : workbook.Sheets[firstName];
  if (!sheet) throw new SourceError(GPR_SOURCE, 'workbook has no readable sheet');
  return XLSX.utils.sheet_to_json<GprCell[]>(sheet, {
    header: 1,
    raw: true,
    defval: '',
    blankrows: true,
  });
}

/**
 * Download the monthly workbook and parse it: the real XLS (readXlsWorkbookRows) by default.
 * `readWorkbook` may be injected (tests, or a different parser). A download or parse failure is a
 * typed SourceError that names the source, never a URL.
 */
export async function fetchGprMonthly(options: {
  readonly fetchImpl: FetchLike;
  readonly readWorkbook?: ((bytes: Uint8Array) => Promise<GprRowMatrix> | GprRowMatrix) | undefined;
  readonly url?: string | undefined;
  /** asOfRule and the GPR_MONTHLY lag come from this config (R3-3). Defaults to MACRO_CONFIG_DEFAULTS. */
  readonly config?: MacroSourceConfig | undefined;
}): Promise<GprMonthlyRow[]> {
  const response = await fetchOk(options.fetchImpl, options.url ?? GPR_XLS_URL, {
    source: GPR_SOURCE,
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  let matrix: GprRowMatrix;
  try {
    matrix = await (options.readWorkbook ?? readXlsWorkbookRows)(bytes);
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError(GPR_SOURCE, 'workbook could not be parsed');
  }
  const setting = asOfSettingFrom(options.config ?? MACRO_CONFIG_DEFAULTS, 'GPR_MONTHLY');
  return parseGprWorkbookRows(matrix, setting);
}
