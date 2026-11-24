/** Formatting shared by the pages. */

/** The first non-empty line of a prompt (without a leading markdown heading mark), trimmed to a readable length. */
export function firstLine(text: string | null): string | null {
  const line = text
    ?.split('\n')
    .map((l) => l.replace(/^#+\s+/, '').trim())
    .find(Boolean);
  if (!line) return null;
  return line.length > 160 ? line.slice(0, 157) + '…' : line;
}

export function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' })} ${time}`;
}

export function formatDuration(start: string | null, end: string | null): string {
  if (!start || !end) return '';
  const mins = Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
  if (mins < 1) return '<1 min';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h} h ${mins % 60} min` : `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** A duration in ms as `850 ms`, `12 s`, `4 min`, `2 h 5 min`, `3 d 4 h`. */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h} h ${mins % 60} min` : `${Math.floor(h / 24)} d ${h % 24} h`;
}

export function formatUsd(v: number): string {
  if (v === 0) return '$0';
  if (v < 0.01) return '<$0.01';
  return v < 100 ? `$${v.toFixed(2)}` : `$${Math.round(v).toLocaleString()}`;
}

/** Token counts as `950`, `12.3k`, `4.5M`, `1.2B`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

export function formatClock(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
}

export function formatPercent(part: number, whole: number): string {
  if (!whole) return '0%';
  const p = (part / whole) * 100;
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
}

/** How long ago, compactly: `now`, `12m`, `5h`, `3d`, `Sep 4`. */
export function formatAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 14 ? `${d}d` : new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** A duration, terminal-compact: `850ms`, `12s`, `4m`, `2h05m`, `3d04h`. */
export function formatDur(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`;
}

/** A timestamp, terminal-compact: `14:05` today, else `21 Nov 14:05` (with the year when not this year). */
export function formatStamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === now.toDateString()) return time;
  const date = d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : '2-digit' });
  return `${date} ${time}`;
}

/** A count, compact: `950`, `13.9k`, `1.2M`. */
export function formatCount(n: number): string {
  if (Math.abs(n) < 1000) return String(Math.round(n));
  if (Math.abs(n) < 1e6) return `${(n / 1e3).toFixed(Math.abs(n) < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}
