/**
 * LSL (Live Session Log) discovery — the one place that knows where sessions live.
 *
 * WHY THIS EXISTS. Session logs used to sit flat in `.specstory/history/` and
 * were written as markdown. They now live in `YYYY/MM/` tranches and are
 * written as `.jsonl`. Two call sites kept their original shape:
 *
 *   readdirSync(specstoryPath).filter(f => f.endsWith('.md'))
 *
 * A flat read of that directory returns `2025/`, `2026/`, `logs/`, `docs/` and
 * a README — so the filter resolved to an empty list while 20,000+ sessions sat
 * one level down. Nothing threw: an empty array is indistinguishable from "no
 * sessions recorded yet", which is why this went unnoticed for months and why
 * `listLslFiles` below WARNS when it finds tranches but no files. A silent zero
 * is the failure mode this module exists to prevent, not merely the recursion.
 *
 * ORDERING IS BY FILENAME, NEVER mtime. Both broken call sites sorted on
 * `statSync().mtime`. A clone, a checkout or a submodule update rewrites mtimes
 * wholesale, which surfaces months-old tranches as "most recent". The filename
 * carries the authoritative start time and is stable across all of that.
 *
 * The parsed instant is the tranche's START. That matters for the 23:00 tranche,
 * which is named `2300-0000`: reading the END would roll over into the next day
 * and date-order it a day late.
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';

/** A discovered session log. */
export interface LslFile {
  /** Absolute path to the file. */
  path: string;
  /** Basename, e.g. `2026-09-21_1600-1700_c197ef.jsonl`. */
  name: string;
  /** Tranche START time, parsed from the filename. */
  date: Date;
}

export interface ListLslOptions {
  /** Keep files at or after this instant. */
  since?: Date | null;
  /** Keep files at or before this instant. */
  until?: Date | null;
  /** Cap the result (applied after ordering). 0 or undefined means no cap. */
  max?: number;
  /** Result order. Defaults to `newest`. */
  order?: 'newest' | 'oldest';
}

/** Both formats coexist while the markdown backfill runs. */
const LSL_EXTENSIONS = ['.jsonl', '.md'];

/**
 * `YYYY-MM-DD_HHMM-` prefix. Deliberately anchored and deliberately partial:
 * matching only the START time keeps `2300-0000` on the correct day, and
 * requiring the prefix is what excludes README.md, chain-map.json and anything
 * else that shares the directory without being a session.
 */
const LSL_NAME = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})-/;

/** The history root for a repository checkout. */
export function lslHistoryRoot(repositoryPath: string): string {
  return path.join(repositoryPath, '.specstory', 'history');
}

/**
 * Start instant encoded in an LSL filename, or null when the name is not a
 * session log. Interpreted as UTC — enough to order files and to bound a date
 * range; the timestamps inside the file remain authoritative for anything finer.
 */
export function parseLslFilenameStart(basename: string): Date | null {
  const m = basename.match(LSL_NAME);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm)));
}

/**
 * True when the root holds at least one `YYYY/MM` tranche directory. Used to
 * tell "this project has no sessions" apart from "discovery is broken again".
 */
export function hasLslTranches(root: string): boolean {
  let years: fs.Dirent[];
  try {
    years = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const y of years) {
    if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
    try {
      const months = fs.readdirSync(path.join(root, y.name), { withFileTypes: true });
      if (months.some((m) => m.isDirectory() && /^\d{2}$/.test(m.name))) return true;
    } catch {
      // Unreadable year directory — keep looking.
    }
  }
  return false;
}

/**
 * Every session log under `root`, recursively, ordered newest-first by default.
 *
 * Returns [] for a project that genuinely has no sessions; logs a warning first
 * when tranches exist, because that combination means this module has drifted
 * from the on-disk layout again.
 */
export function listLslFiles(root: string, opts: ListLslOptions = {}): LslFile[] {
  const out: LslFile[] = [];

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable subtree is not fatal to the rest of the scan.
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!LSL_EXTENSIONS.some((ext) => e.name.endsWith(ext))) continue;
      const date = parseLslFilenameStart(e.name);
      if (!date) continue;
      out.push({ path: full, name: e.name, date });
    }
  };

  if (fs.existsSync(root)) walk(root);

  let files = out;
  if (opts.since) files = files.filter((f) => f.date >= opts.since!);
  if (opts.until) files = files.filter((f) => f.date <= opts.until!);

  files.sort((a, b) =>
    opts.order === 'oldest'
      ? a.date.getTime() - b.date.getTime()
      : b.date.getTime() - a.date.getTime()
  );

  if (opts.max && opts.max > 0) files = files.slice(0, opts.max);

  if (out.length === 0 && hasLslTranches(root)) {
    log(
      `LSL discovery found 0 session files under ${root} despite YYYY/MM tranches being present — ` +
        'the on-disk layout has changed and this scanner no longer matches it',
      'warning',
      { root }
    );
  }

  return files;
}
