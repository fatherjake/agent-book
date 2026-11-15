import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_DIR = process.env.FRUGAL_LOG_DIR ?? join(process.cwd(), 'results', 'logs');
const QUIET = process.env.FRUGAL_QUIET === '1';

/** Structured JSONL logger. Writes to results/logs/<date>.jsonl and a short line to stderr. */
export function log(level: LogLevel, component: string, msg: string, data: Record<string, unknown> = {}): void {
  const entry = { ts: new Date().toISOString(), level, component, msg, ...data };
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, `${entry.ts.slice(0, 10)}.jsonl`), JSON.stringify(entry) + '\n');
  } catch {
    /* logging must never crash the runner */
  }
  if (!QUIET && level !== 'debug') process.stderr.write(`[${level}] ${component}: ${msg}\n`);
}

export const logger = (component: string) => ({
  debug: (m: string, d?: Record<string, unknown>) => log('debug', component, m, d),
  info: (m: string, d?: Record<string, unknown>) => log('info', component, m, d),
  warn: (m: string, d?: Record<string, unknown>) => log('warn', component, m, d),
  error: (m: string, d?: Record<string, unknown>) => log('error', component, m, d),
});
