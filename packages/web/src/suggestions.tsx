/**
 * The Suggestions tab and its detail panel. Analyse the session (a button), read and edit the task brief
 * the evaluations replay, then run any suggestion: N baseline and N with-the-change replays, judged
 * against the brief's checks, compared on medians.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { formatDur, formatStamp, formatTokens, formatUsd } from './format';
import { compare, finished, METRICS, runTokens, checksMet, type Lab, type MetricComparison, type Run, type Suggestion } from './lab';
import { ClampMarkdown, DiffView, Row } from './parts';
import { sameSel, toHash, type Selection } from './view';

const KIND_LABEL: Record<Suggestion['kind'], string> = {
  instructions: 'instructions',
  skill: 'skill',
  process: 'process',
  lint: 'lint',
  hook: 'hook',
  docs: 'docs',
  other: 'other',
};

const active = (r: Run) => r.status === 'running' || r.status === 'judging';

/** Elapsed time that ticks while something runs. */
function Elapsed({ since }: { since: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="num">{formatDur(Date.now() - Date.parse(since))}</span>;
}

function Delta({ c, kind }: { c: MetricComparison | undefined; kind: 'pct' | 'checks' }) {
  if (!c || !Number.isFinite(c.change)) return <span className="dim">—</span>;
  const text = kind === 'checks' ? `${c.change > 0 ? '+' : c.change < 0 ? '−' : '±'}${Math.round(Math.abs(c.change) * 100)}pt` : `${c.change > 0 ? '+' : c.change < 0 ? '−' : '±'}${Math.round(Math.abs(c.change) * 100)}%`;
  const cls = c.noise || c.better === null ? 'dim' : c.better ? 'up' : 'down';
  return (
    <span className={`num ${cls}`} title={c.noise ? 'Within run-to-run noise' : undefined}>
      {c.noise ? '~' : ''}
      {text}
    </span>
  );
}

// --- The tab --------------------------------------------------------------------------------------

export function SuggestionsTab({ lab, sel, select }: { lab: Lab; sel: Selection | null; select: (kind: Selection['kind'], key: string) => void }) {
  const s = lab.state;
  const a = s?.analysis;
  if (!s) return <p className="pad dim">{lab.error ?? 'Loading…'}</p>;

  if (!a || a.status === 'failed') {
    return (
      <div className="pad">
        <p className="lab-intro">
          Analyse this session to get suggestions for the agent setup: instructions in CLAUDE.md, skills, processes and scripts, lint rules, hooks, docs. The analysis works from the session itself
          and also writes a task brief from it. Then run any suggestion to test it: the brief is replayed headless in a throwaway workspace with and without the change, and the runs are compared on
          cost, tokens, time and checks met. The workspace is a git worktree at the session's start when the project is a git repository, a copy of the folder when it isn't, or an empty folder
          when there's no folder. Your own files are never modified.
        </p>
        {a?.status === 'failed' && <p className="down">The last analysis failed: {a.error}</p>}
        {lab.error && <p className="down">{lab.error}</p>}
        <button className="button primary" onClick={() => void lab.analyse()}>
          Analyse session
        </button>
        <p className="dim small">Runs a read-only Claude (Opus) over the session's telemetry, and the project's files when they're on disk. Usually a few minutes.</p>
      </div>
    );
  }

  if (a.status === 'running') {
    return (
      <div className="pad">
        <p>
          Analysing the session… <Elapsed since={a.startedAt} />
        </p>
        <p className="dim small">
          Reading the conversation{a.source.kind === 'empty' ? '' : ' and the project'}. Replays will start from: {a.sourceLabel}. Suggestions appear here when it's done.
        </p>
        <button className="button" onClick={() => void lab.stop()}>
          Stop
        </button>
      </div>
    );
  }

  const brief = s.brief!;
  const base = finished(s.baseline, brief.version);
  return (
    <div className="pad">
      <div className="lab-meta dim small">
        <span title="Where replays start: a git worktree at the session's start, a copy of its folder, or an empty folder">
          starts from <span className="mono">{a.sourceLabel}</span>
        </span>
        <span>
          replays on <span className="mono">{a.model}</span>
        </span>
        <span>analysis {formatUsd(a.costUsd ?? 0)}</span>
        <button className="link-button" onClick={() => void lab.analyse()} title="Start over: a new brief and new suggestions (existing runs are discarded)">
          re-analyse
        </button>
      </div>
      {lab.error && <p className="down">{lab.error}</p>}
      <Brief lab={lab} />

      <div className="block-title">
        Suggestions <span className="dim">{s.suggestions.length}</span>
      </div>
      {s.suggestions.length === 0 ? (
        <p className="dim small">The analysis found nothing worth changing.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th className="r">#</th>
              <th>Suggestion</th>
              <th className="r">Checks</th>
              <th className="r">Cost</th>
              <th className="r">Tokens</th>
              <th className="r">Time</th>
              <th className="r">Runs</th>
            </tr>
          </thead>
          <tbody>
            {s.suggestions.map((x) => {
              const cand = finished(x.runs, brief.version);
              const cmp = compare(base, cand);
              return (
                <Row key={x.id} selected={sameSel(sel, 'suggestion', x.id)} onSelect={() => select('suggestion', x.id)} title={x.description} className={x.decision}>
                  <td className="r num dim">{x.rank}</td>
                  <td className="ellipsis wide">
                    <span className="chip kind">{KIND_LABEL[x.kind]}</span> {x.title}
                  </td>
                  <td className="r">
                    <Delta c={cmp?.checks} kind="checks" />
                  </td>
                  <td className="r">
                    <Delta c={cmp?.cost} kind="pct" />
                  </td>
                  <td className="r">
                    <Delta c={cmp?.tokens} kind="pct" />
                  </td>
                  <td className="r">
                    <Delta c={cmp?.time} kind="pct" />
                  </td>
                  <td className="r nowrap" onClick={(e) => e.stopPropagation()}>
                    <RunControl lab={lab} s={x} version={brief.version} />
                  </td>
                </Row>
              );
            })}
            <Row selected={sameSel(sel, 'suggestion', 'baseline')} onSelect={() => select('suggestion', 'baseline')}>
              <td className="r num dim">—</td>
              <td className="ellipsis wide dim">Baseline: the brief with no change</td>
              <td colSpan={4} className="r dim small">
                {base.length ? `${base.length} run${base.length === 1 ? '' : 's'}` : 'runs with the first suggestion you run'}
              </td>
              <td className="r num dim">{s.baseline.some(active) ? 'running' : ''}</td>
            </Row>
          </tbody>
        </table>
      )}
      {a.rejected.length > 0 && (
        <p className="dim small">
          {a.rejected.length} suggestion{a.rejected.length === 1 ? '' : 's'} left out because their edits didn't apply:{' '}
          {a.rejected.map((r) => r.title).join('; ')}.
        </p>
      )}
    </div>
  );
}

/** Run (or Stop), then accept and reject. Clicking the current decision again clears it. */
function RunControl({ lab, s, version }: { lab: Lab; s: Suggestion; version: number }) {
  const toggle = (d: 'accepted' | 'rejected') => void lab.decide(s.id, s.decision === d ? null : d);
  return (
    <span className="run-control">
      <RunButtons lab={lab} s={s} version={version} />
      <button
        className={`button small decide accept${s.decision === 'accepted' ? ' on' : ''}`}
        onClick={() => toggle('accepted')}
        aria-pressed={s.decision === 'accepted'}
        aria-label="Accept"
        title={s.decision === 'accepted' ? 'Accepted (click to undo)' : 'Accept'}
      >
        ✓
      </button>
      <button
        className={`button small decide reject${s.decision === 'rejected' ? ' on' : ''}`}
        onClick={() => toggle('rejected')}
        aria-pressed={s.decision === 'rejected'}
        aria-label="Reject"
        title={s.decision === 'rejected' ? 'Rejected (click to undo)' : 'Reject'}
      >
        ✕
      </button>
    </span>
  );
}

function RunButtons({ lab, s, version }: { lab: Lab; s: Suggestion; version: number }) {
  const [n, setN] = useState(1);
  const going = s.runs.filter((r) => r.briefVersion === version && active(r)).length;
  const done = finished(s.runs, version).length;
  if (going)
    return (
      <>
        <span className="dim num">
          {done}/{done + going}
        </span>
        <button className="button small" onClick={() => void lab.stop(s.id)}>
          Stop
        </button>
      </>
    );
  return (
    <>
      {done > 0 && <span className="dim num">{done}×</span>}
      <select value={n} onChange={(e) => setN(Number(e.target.value))} aria-label="Runs per side" title="Runs per side: this many baseline and this many with the change">
        {[1, 2, 3, 4, 5].map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      <button className="button small" onClick={() => void lab.run(s.id, Math.max(n, done + (done ? 1 : 0)))} title={done ? 'Add runs on each side' : 'Run this many on each side'}>
        {done ? 'More' : 'Run'}
      </button>
    </>
  );
}

/** The task the evaluations replay, editable. */
function Brief({ lab }: { lab: Lab }) {
  const b = lab.state!.brief!;
  const [editing, setEditing] = useState(false);
  const [task, setTask] = useState(b.task);
  const [checks, setChecks] = useState(b.checks.join('\n'));
  const [budget, setBudget] = useState(String(b.budgetUsd));
  const start = () => {
    setTask(b.task);
    setChecks(b.checks.join('\n'));
    setBudget(String(b.budgetUsd));
    setEditing(true);
  };
  if (editing)
    return (
      <div className="brief editing">
        <div className="block-title">Brief</div>
        <label className="field">
          <span className="dim small">Task</span>
          <textarea value={task} rows={5} onChange={(e) => setTask(e.target.value)} />
        </label>
        <label className="field">
          <span className="dim small">Checks, one per line</span>
          <textarea value={checks} rows={5} onChange={(e) => setChecks(e.target.value)} />
        </label>
        <label className="field inline">
          <span className="dim small">Budget per run ($)</span>
          <input type="number" min={0.5} max={200} step={0.5} value={budget} onChange={(e) => setBudget(e.target.value)} />
        </label>
        <p className="dim small">Changing the task or checks starts a new brief version: runs on the old one stay listed but aren't compared.</p>
        <div className="row-gap">
          <button
            className="button primary"
            onClick={async () => {
              await lab.saveBrief(task, checks.split('\n').map((c) => c.trim()).filter(Boolean), Number(budget));
              setEditing(false);
            }}
          >
            Save
          </button>
          <button className="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  return (
    <div className="brief">
      <div className="block-title">
        Brief <span className="dim">v{b.version}{b.edited ? ' · edited' : ''} · up to {formatUsd(b.budgetUsd)} a run</span>{' '}
        <button className="link-button" onClick={start}>
          edit
        </button>
      </div>
      <div className="bubble you">
        <ClampMarkdown text={`${b.task}\n\n**Checks** (for the judge; the replay doesn't see them)\n\n${b.checks.map((c) => `- ${c}`).join('\n')}`} lines={6} />
      </div>
    </div>
  );
}

// --- The detail panel -----------------------------------------------------------------------------

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="block-title">{title}</div>
      {children}
    </>
  );
}

export function SuggestionDetail({ lab, id }: { lab: Lab; id: string }) {
  const s = lab.state;
  if (!s?.brief) return <p className="pad dim">Analyse the session first.</p>;
  const v = s.brief.version;
  const base = finished(s.baseline, v);

  if (id === 'baseline')
    return (
      <div className="pad">
        <div className="detail-title">Baseline</div>
        <p className="recap">The brief replayed with the repository as it was, no change applied. Every suggestion is compared with these runs.</p>
        <Section title={`Runs ${s.baseline.length}`}>
          <RunList runs={s.baseline} version={v} />
        </Section>
      </div>
    );

  const x = s.suggestions.find((y) => y.id === id);
  if (!x) return <p className="pad dim">That suggestion isn't in the latest analysis.</p>;
  const cand = finished(x.runs, v);
  const cmp = compare(base, cand);
  return (
    <div className="pad">
      <div className="detail-title">
        <span className="chip kind">{KIND_LABEL[x.kind]}</span> {x.title}
      </div>
      {x.decision && (
        <p className={`small ${x.decision === 'accepted' ? 'up' : 'down'}`}>
          {x.decision === 'accepted' ? '✓ Accepted' : '✕ Rejected'} {x.decidedAt && <span className="dim">{formatStamp(x.decidedAt)}</span>}
        </p>
      )}
      <p>{x.description}</p>
      {x.expected && (
        <p className="dim small">
          <span className="strong">Expected:</span> {x.expected}
        </p>
      )}
      {x.evidence && (
        <p className="dim small">
          <span className="strong">Evidence:</span> {x.evidence}
        </p>
      )}

      <Section title="Results">
        {cmp ? (
          <table className="grid compare">
            <thead>
              <tr>
                <th />
                <th className="r">Baseline</th>
                <th className="r">With change</th>
                <th className="r">Change</th>
              </tr>
            </thead>
            <tbody>
              {METRICS.map((m) => {
                const c = cmp[m.key];
                const fmt = (val: number) =>
                  !Number.isFinite(val) ? '—' : m.key === 'checks' ? `${Math.round(val * 100)}%` : m.key === 'cost' ? formatUsd(val) : m.key === 'tokens' ? formatTokens(val) : m.key === 'time' ? formatDur(val) : String(Math.round(val));
                return (
                  <tr key={m.key}>
                    <td className="dim">{m.label}</td>
                    <td className="r num">{fmt(c.base)}</td>
                    <td className="r num">{fmt(c.cand)}</td>
                    <td className="r">
                      <Delta c={c} kind={m.key === 'checks' ? 'checks' : 'pct'} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="dim small">No finished runs to compare yet. Pick how many runs per side and press Run in the table.</p>
        )}
        {cmp && (
          <p className="dim small">
            Medians of {base.length} baseline and {cand.length} with-change run{cand.length === 1 ? '' : 's'}. ~ marks a difference within run-to-run noise.
          </p>
        )}
      </Section>

      <Section title={`Runs ${x.runs.length}`}>
        <RunList runs={x.runs} version={v} />
      </Section>

      <Section title="The change">
        <DiffView diff={x.diff} />
      </Section>
    </div>
  );
}

function RunList({ runs, version }: { runs: Run[]; version: number }) {
  if (!runs.length) return <p className="dim small">None yet.</p>;
  return (
    <ol className="runs">
      {[...runs].reverse().map((r) => (
        <RunRow key={r.id} r={r} stale={r.briefVersion !== version} />
      ))}
    </ol>
  );
}

function RunRow({ r, stale }: { r: Run; stale: boolean }) {
  const [open, setOpen] = useState(false);
  const status = r.status === 'running' ? (r.ending === 'queued' ? 'queued' : 'running') : r.status === 'judging' ? 'judging' : r.status === 'failed' ? (r.ending ?? 'failed') : r.ending === 'success' ? 'done' : (r.ending ?? 'done');
  return (
    <li className={stale ? 'stale' : undefined}>
      <button className="tool-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tool-name">{r.arm === 'baseline' ? 'base' : 'change'}</span>
        <span className="tool-label">
          {r.judge ? (
            <span className={checksMet(r) === r.judge.checks.length ? 'up' : undefined}>
              {checksMet(r)}/{r.judge.checks.length} checks
            </span>
          ) : (
            <span className={r.status === 'failed' ? 'down' : 'dim'}>{status}</span>
          )}
          {r.costUsd != null && ` · ${formatUsd(r.costUsd)} · ${formatTokens(runTokens(r))} tok · ${formatDur(r.durationMs)} · ${r.toolCalls ?? 0} tools`}
          {stale && ' · old brief'}
        </span>
        <span className="dim num nowrap">{formatStamp(r.startedAt)}</span>
      </button>
      {open && (
        <div className="tool-detail">
          {r.error && <p className="down small">{r.error}</p>}
          {r.ending && r.ending !== 'success' && r.status !== 'running' && <p className="dim small">Ended: {r.ending}</p>}
          {r.judge && (
            <>
              <p className="small">{r.judge.summary}</p>
              <ul className="judge">
                {r.judge.checks.map((c, i) => (
                  <li key={i}>
                    <span className={c.met ? 'up' : 'down'}>{c.met ? '✓' : '✕'}</span> {c.check} <span className="dim">— {c.why}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {r.result && (
            <>
              <div className="block-title">Final message</div>
              <pre className="code">{r.result}</pre>
            </>
          )}
          {r.diffStat && (
            <>
              <div className="block-title">What it changed</div>
              <pre className="code">{r.diffStat}</pre>
            </>
          )}
          {r.diff && (
            <details>
              <summary className="dim small">Full diff</summary>
              <DiffView diff={r.diff} />
            </details>
          )}
          <p className="small">
            <a className="link-button" href={toHash({ id: r.sessionId, tab: 'convo', sel: null })}>
              open the replay's session →
            </a>
          </p>
        </div>
      )}
    </li>
  );
}
