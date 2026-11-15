/**
 * Repo paths and a tiny .env loader (no dotenv dependency).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function resultsDir(): string {
  return process.env.FRUGAL_RESULTS_DIR ? resolve(process.env.FRUGAL_RESULTS_DIR) : join(REPO_ROOT, 'results');
}

export const CONFIGS_DIR = join(REPO_ROOT, 'configs');
export const SPEC_DIR = join(REPO_ROOT, 'benchmark', 'spec');

/** Parse KEY=VALUE lines. Supports comments, `export ` prefix, and single/double quoted values. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    }
    out[m[1]] = value;
  }
  return out;
}

let loaded = false;
/** Load <repo>/.env into process.env without overriding variables that are already set. */
export function loadDotEnv(path: string = join(REPO_ROOT, '.env')): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(path)) return;
  try {
    const vars = parseDotEnv(readFileSync(path, 'utf8'));
    for (const [k, v] of Object.entries(vars)) {
      if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
    }
  } catch {
    /* unreadable .env is not fatal */
  }
}
