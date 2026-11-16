import { Fragment, useState, type ReactNode } from 'react';
import * as f from '../format';
import { relChange, summarize, taskOf, type Summary } from '../stats';
import type { Run, SuggestionStatus, Task, TaskKind } from '../types';

export function Badge({ tone = 'plain', children }: { tone?: 'plain' | 'good' | 'bad' | 'live' | 'muted' | 'strong'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function SessionStatus({ status }: { status: 'running' | 'done' }) {
  return status === 'running' ? <Badge tone="live">Running</Badge> : <Badge tone="muted">Done</Badge>;
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
 * A change between the session's runs and a suggestion's runs. `lowerIsBetter` for costs; changes
 * smaller than `noise` are shown neutral.
 */
export function Delta({ value, kind, lowerIsBetter = false, noise = 0.03 }: { value: number | null; kind: 'rel' | 'pts'; lowerIsBetter?: boolean; noise?: number }) {
  if (value === null || !Number.isFinite(value)) return <span className="delta">—</span>;
  const good = lowerIsBetter ? value < 0 : value > 0;
  const tone = Math.abs(value) < noise ? 'flat' : good ? 'good' : 'bad';
  const text = kind === 'rel' ? `${value > 0 ? '+' : ''}${(value * 100).toFixed(0)}%` : `${value > 0 ? '+' : ''}${(value * 100).toFixed(0)} pts`;
  return <span className={`delta delta-${tone}`}>{text}</span>;
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

/** The five key averages of a set of runs, optionally with the change from a baseline set. */
export function summaryMetrics(s: Summary, base?: Summary): MetricItem[] {
  const d = (cur: number | null, ref: number | null | undefined) => (base ? relChange(ref ?? null, cur) : null);
  return [
    {
      label: 'Acceptance criteria',
      value: f.pct(s.criteria),
      sub: base ? <Delta value={s.criteria !== null && base.criteria !== null ? s.criteria - base.criteria : null} kind="pts" /> : `${s.criteriaMet} of ${s.criteriaTotal} met`,
    },
    { label: 'Avg tokens', value: f.tokens(s.tokens), sub: base ? <Delta value={d(s.tokens, base.tokens)} kind="rel" lowerIsBetter /> : 'per run' },
    { label: 'Avg cost', value: f.usd(s.costUsd), sub: base ? <Delta value={d(s.costUsd, base.costUsd)} kind="rel" lowerIsBetter /> : 'per run' },
    { label: 'Avg time', value: f.duration(s.durationMs), sub: base ? <Delta value={d(s.durationMs, base.durationMs)} kind="rel" lowerIsBetter /> : 'per run' },
    { label: 'Runs', value: String(s.runs), sub: s.running ? `${s.running} running` : `${s.done} finished` },
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
            Average <span className="dim">· {s.done} finished</span>
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
                <td className="r">{r.status === 'running' ? <Badge tone="live">Running</Badge> : <CriteriaBar met={r.criteriaMet.length} total={t.criteria.length} />}</td>
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
                    <ul className="checklist">
                      {t.criteria.map((c) => {
                        const ok = r.criteriaMet.includes(c.id);
                        return (
                          <li key={c.id} className={r.status === 'running' ? 'pending' : ok ? 'ok' : 'no'}>
                            <span className="mark">{r.status === 'running' ? '…' : ok ? '✓' : '✕'}</span>
                            {c.label}
                          </li>
                        );
                      })}
                    </ul>
                    <div className="dim small mono">
                      {r.id} · <Ago iso={r.createdAt} />
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

export function Diff({ file, diff }: { file: string; diff: string }) {
  return (
    <div className="diff">
      <div className="diff-file mono">{file}</div>
      <pre>
        {diff.split('\n').map((line, i) => {
          const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
          return (
            <div key={i} className={`dl dl-${cls}`}>
              {line || ' '}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
