import { Fragment, useState, type ReactNode } from 'react';
import * as f from '../format';
import { relChange, summarize, taskOf, type Interval, type Paired, type Summary } from '../stats';
import type { Run, SessionStatus as SessionStatusT, SuggestionStatus, Task, TaskKind } from '../types';

export function Badge({ tone = 'plain', children }: { tone?: 'plain' | 'good' | 'bad' | 'live' | 'muted' | 'strong'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

const SESSION_STATUS: Record<SessionStatusT, [string, 'live' | 'muted' | 'bad']> = {
  running: ['Running', 'live'],
  analysing: ['Analysing', 'live'],
  testing: ['Testing suggestions', 'live'],
  done: ['Done', 'muted'],
  failed: ['Failed', 'bad'],
};
export function SessionStatus({ status }: { status: SessionStatusT }) {
  const [label, tone] = SESSION_STATUS[status] ?? [status, 'muted'];
  return <Badge tone={tone}>{label}</Badge>;
}

const SUGGESTION_TONE: Record<SuggestionStatus, 'plain' | 'good' | 'bad' | 'live' | 'muted' | 'strong'> = {
  proposed: 'muted',
  testing: 'live',
  tested: 'strong',
  accepted: 'good',
  rejected: 'bad',
};
const SUGGESTION_LABEL: Record<SuggestionStatus, string> = {
  proposed: 'Proposed',
  testing: 'Testing',
  tested: 'Ready to review',
  accepted: 'Accepted',
  rejected: 'Rejected',
};
export function SuggestionStatusBadge({ status }: { status: SuggestionStatus }) {
  return <Badge tone={SUGGESTION_TONE[status]}>{SUGGESTION_LABEL[status]}</Badge>;
}

export function KindTag({ kind }: { kind: TaskKind }) {
  return <span className={`kind kind-${kind}`}>{kind}</span>;
}

export function CriteriaBar({ met, total, asPct = false }: { met: number; total: number; asPct?: boolean }) {
  const share = total ? met / total : 0;
  return (
    <span className="crit" title={asPct ? `${f.pct(share)} of acceptance criteria met` : `${met} of ${total} acceptance criteria met`}>
      <span className="crit-bar">
        <span className="crit-fill" style={{ width: `${share * 100}%` }} data-full={met === total ? '' : undefined} />
      </span>
      <span className="num">{asPct ? f.pct(share) : `${met}/${total}`}</span>
    </span>
  );
}

export function Ago({ iso }: { iso: string }) {
  return <time title={f.fullDate(iso)}>{f.ago(iso)}</time>;
}

/**
 * A change between the session's runs and a suggestion's runs. The sign decides the colour: positive
 * green, negative red, zero grey. `~` marks a change whose paired 95% range includes zero (within noise).
 */
export function Delta({
  value,
  kind,
  interval,
}: {
  value: number | null;
  kind: 'rel' | 'pts';
  /** Kept for call sites; colour is by sign only. */
  lowerIsBetter?: boolean;
  /** Paired 95% range; when it includes zero the change is marked as within noise. */
  interval?: Interval | null;
}) {
  if (value === null || !Number.isFinite(value)) return <span className="delta">—</span>;
  const shown = Math.round(value * 100);
  const tone = shown > 0 ? 'up' : shown < 0 ? 'down' : 'zero';
  const uncertain = interval ? interval.inconclusive : false;
  const fmt = (v: number) => (kind === 'rel' ? `${v > 0 ? '+' : ''}${(v * 100).toFixed(0)}%` : `${v > 0 ? '+' : ''}${(v * 100).toFixed(0)} pts`);
  const title = interval
    ? Number.isFinite(interval.lo)
      ? `95% range over the paired runs: ${fmt(interval.lo)} to ${fmt(interval.hi)}${uncertain ? ' (includes zero: within noise)' : ''}`
      : 'Only one paired run: no range yet'
    : undefined;
  return (
    <span className={`delta delta-${tone}${uncertain ? ' delta-uncertain' : ''}`} title={title}>
      {fmt(value)}
      {uncertain ? <span className="noise"> ~</span> : null}
    </span>
  );
}

export interface MetricItem {
  label: string;
  value: string;
  sub?: ReactNode;
}

export function Metrics({ items }: { items: MetricItem[] }) {
  return (
    <div className="metrics">
      {items.map((m) => (
        <div className="metric" key={m.label}>
          <div className="metric-label">{m.label}</div>
          <div className="metric-value num">{m.value}</div>
          {m.sub !== undefined && <div className="metric-sub">{m.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/** The five key averages of a set of runs, optionally with the change from a baseline set (noise-aware when paired). */
export function summaryMetrics(s: Summary, base?: Summary, pr?: Paired): MetricItem[] {
  const d = (cur: number | null, ref: number | null | undefined) => (base ? relChange(ref ?? null, cur) : null);
  return [
    {
      label: 'Acceptance criteria',
      value: f.pct(s.criteria),
      sub: base ? <Delta value={s.criteria !== null && base.criteria !== null ? s.criteria - base.criteria : null} kind="pts" interval={pr?.criteria} /> : `${s.criteriaMet} of ${s.criteriaTotal} met`,
    },
    { label: 'Avg tokens', value: f.tokens(s.tokens), sub: base ? <Delta value={d(s.tokens, base.tokens)} kind="rel" lowerIsBetter interval={pr?.tokens} /> : 'per run' },
    { label: 'Avg cost', value: f.usd(s.costUsd), sub: base ? <Delta value={d(s.costUsd, base.costUsd)} kind="rel" lowerIsBetter interval={pr?.tokens} /> : 'per run' },
    { label: 'Avg time', value: f.duration(s.durationMs), sub: base ? <Delta value={d(s.durationMs, base.durationMs)} kind="rel" lowerIsBetter interval={pr?.time} /> : 'per run' },
    {
      label: 'Runs',
      value: `${s.done}/${s.runs}`,
      sub: [s.pending ? `${s.pending} running` : 'finished', s.errors ? `${s.errors} failed` : '', s.done ? `skills used in ${s.skillsFired}/${s.done}` : ''].filter(Boolean).join(' · '),
    },
  ];
}

/** Runs with an average row on top; a run expands to its acceptance criteria. */
export function RunsTable({ runs, tasks, compact = false }: { runs: Run[]; tasks: Task[]; compact?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const s = summarize(runs, tasks);
  if (!runs.length) return <p className="empty">No runs yet.</p>;
  return (
    <table className="table runs">
      <thead>
        <tr>
          <th>Task</th>
          <th className="r">Criteria</th>
          <th className="r">Tokens</th>
          <th className="r">Cost</th>
          <th className="r">Time</th>
          {!compact && <th className="r">Created</th>}
        </tr>
      </thead>
      <tbody>
        <tr className="avg">
          <td>
            Average <span className="dim">· {s.done} finished{s.pending ? `, ${s.pending} running` : ''}</span>
          </td>
          <td className="r">
            <CriteriaBar met={s.criteriaMet} total={s.criteriaTotal} asPct />
          </td>
          <td className="r num">{f.tokens(s.tokens)}</td>
          <td className="r num">{f.usd(s.costUsd)}</td>
          <td className="r num">{f.duration(s.durationMs)}</td>
          {!compact && <td />}
        </tr>
        {runs.map((r) => {
          const t = taskOf(tasks, r.taskId);
          const isOpen = open === r.id;
          return (
            <Fragment key={r.id}>
              <tr className={'run' + (isOpen ? ' open' : '')} onClick={() => setOpen(isOpen ? null : r.id)} title="Show acceptance criteria">
                <td>
                  <span className="chev">{isOpen ? '▾' : '▸'}</span>
                  <KindTag kind={t.kind} /> <span className="task-title">{t.title}</span>
                </td>
                <td className="r">
                  {r.status === 'done' ? (
                    <CriteriaBar met={r.criteriaMet.length} total={t.criteria.length} />
                  ) : r.status === 'error' ? (
                    <Badge tone="bad">Failed</Badge>
                  ) : (
                    <Badge tone="live">{r.status === 'queued' ? 'Queued' : 'Running'}</Badge>
                  )}
                </td>
                <td className="r num">{f.tokens(r.tokens)}</td>
                <td className="r num">{f.usd(r.costUsd)}</td>
                <td className="r num">{f.duration(r.durationMs)}</td>
                {!compact && (
                  <td className="r dim">
                    <Ago iso={r.createdAt} />
                  </td>
                )}
              </tr>
              {isOpen && (
                <tr className="detail">
                  <td colSpan={compact ? 5 : 6}>
                    {r.error && <div className="run-error">{r.error}</div>}
                    <ul className="checklist">
                      {t.criteria.map((c) => {
                        const pending = r.status !== 'done';
                        const ok = r.criteriaMet.includes(c.id);
                        const failing = (r.criteriaDetail[c.id]?.checks ?? []).filter((x) => x.outcome !== 'pass');
                        return (
                          <li key={c.id} className={pending ? 'pending' : ok ? 'ok' : 'no'}>
                            <span className="mark">{pending ? '·' : ok ? '✓' : '✕'}</span>
                            {c.label}
                            {!pending && !ok && failing.length > 0 && (
                              <div className="why">
                                {failing.map((x) => (
                                  <div key={x.id}>
                                    <span className="mono">{x.id}</span> {x.outcome}
                                    {x.message ? `: ${x.message.split('\n')[0].slice(0, 220)}` : ''}
                                  </div>
                                ))}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    <div className="dim small">
                      <span className="mono">{r.id}</span> · started <Ago iso={r.createdAt} />
                      {r.skillsFired !== null && <> · {r.skillsFired ? 'used the repo skills' : <span className="bad-text">did not use the repo skills</span>}</>}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

/** A git diff, one block per file (header lines dropped; hunks, additions and deletions shown). */
export function Diff({ file, diff }: { file: string; diff: string }) {
  const files: { path: string; lines: string[] }[] = [];
  for (const line of diff.split('\n')) {
    const m = line.match(/^diff --git a\/(\S+) b\//);
    if (m) {
      files.push({ path: m[1], lines: [] });
      continue;
    }
    if (/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(line)) continue;
    if (!files.length) files.push({ path: file, lines: [] });
    files[files.length - 1].lines.push(line);
  }
  return (
    <>
      {files.map((f) => (
        <div className="diff" key={f.path}>
          <div className="diff-file mono">{f.path}</div>
          <pre>
            {f.lines
              .filter((l, i, a) => !(i === a.length - 1 && l === ''))
              .map((line, i) => {
                const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
                return (
                  <div key={i} className={`dl dl-${cls}`}>
                    {line || ' '}
                  </div>
                );
              })}
          </pre>
        </div>
      ))}
    </>
  );
}
