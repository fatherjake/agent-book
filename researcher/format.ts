/** Terminal/Markdown formatting helpers for the CLI and reports. */

export const MOCK = '[MOCK]';
/** Evaluated without the LLM browser agent: incomplete evaluation, never eligible for promotion. */
export const NO_BROWSER = '[NO-BROWSER-AGENT]';

export const fmtTokens = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US'));
export const fmtUsd = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : `$${n.toFixed(n < 1 ? 4 : 2)}`);
export const fmtPct = (n: number | null | undefined, digits = 1): string => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n.toFixed(digits)}%`);
export const fmtDuration = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};
export const fmtScore = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : n.toFixed(1));
export const mockTag = (isMock: boolean | null | undefined): string => (isMock ? ` ${MOCK}` : '');
export const noBrowserTag = (skipped: boolean | null | undefined): string => (skipped ? ` ${NO_BROWSER}` : '');
/** Both markers, e.g. ' [MOCK] [NO-BROWSER-AGENT]'. */
export const flagTags = (isMock: boolean | null | undefined, browserAgentSkipped: boolean | null | undefined): string =>
  mockTag(isMock) + noBrowserTag(browserAgentSkipped);

/** Plain-text table with aligned columns. */
export function textTable(headers: string[], rows: (string | number)[][]): string {
  const cells = [headers, ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) => r.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [line(cells[0]), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.slice(1).map(line)].join('\n');
}

/** GitHub-flavoured Markdown table. */
export function mdTable(headers: string[], rows: (string | number)[][]): string {
  const esc = (s: string | number) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [`| ${headers.map(esc).join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
}
