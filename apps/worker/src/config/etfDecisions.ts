/**
 * ETF decision dates from the admin JSON file (CSN-024 R5-1; spec item 4).
 *
 * The path comes from COINSNIPE_ETF_DECISIONS_PATH (.env.example). Relative paths resolve from the
 * working directory. There is no default file: an unset variable is the only "not configured" case.
 * It returns status 'unavailable' with a warning and no file is read, so the etf kind is not replaced
 * and its stored rows are left alone (the calendar's kindsOk gate).
 *
 * A configured path is read as configured. A missing or unreadable file, or invalid JSON, returns
 * status 'unavailable' with a warning. A valid file with a bad entry is rejected by
 * parseEtfDecisionEntries inside the calendar, which also reports it. A configured file holding a
 * deliberately empty list loads and clears the etf rows inside the calendar window being replaced; etf rows
 * dated before that window are left untouched.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ETF_DECISIONS_ENV = 'COINSNIPE_ETF_DECISIONS_PATH';

export type EtfDecisionsInput =
  | { readonly status: 'loaded'; readonly path: string; readonly json: unknown }
  | { readonly status: 'unavailable'; readonly path: string | undefined; readonly warning: string };

/** The configured admin file, resolved from `cwd`. Undefined when the variable is unset or blank. */
export function etfDecisionsPath(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string = process.cwd(),
): string | undefined {
  const configured = env[ETF_DECISIONS_ENV]?.trim();
  return configured ? resolve(cwd, configured) : undefined;
}

export function loadEtfDecisions(
  env: Readonly<Record<string, string | undefined>>,
  options: {
    readonly cwd?: string | undefined;
    readonly read?: ((path: string) => string) | undefined;
  } = {},
): EtfDecisionsInput {
  const path = etfDecisionsPath(env, options.cwd);
  // F1: the only "not configured" case. No file is read, so nothing can be mistaken for an admin list.
  if (path === undefined) {
    return {
      status: 'unavailable',
      path: undefined,
      warning: `ETF decisions file is not configured: ${ETF_DECISIONS_ENV} is not set; no ETF rows written, stored ETF rows left untouched`,
    };
  }
  const read = options.read ?? ((file: string) => readFileSync(file, 'utf8'));
  let text: string;
  try {
    text = read(path);
  } catch {
    return {
      status: 'unavailable',
      path,
      warning: `ETF decisions file not readable at ${path}: no ETF rows written, stored ETF rows left untouched`,
    };
  }
  try {
    return { status: 'loaded', path, json: JSON.parse(text) as unknown };
  } catch {
    return {
      status: 'unavailable',
      path,
      warning: `ETF decisions file at ${path} is not valid JSON: no ETF rows written, stored ETF rows left untouched`,
    };
  }
}
