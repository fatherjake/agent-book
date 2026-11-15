import { useMemo, useState } from 'react';
import { useApi } from '../api';
import type { ExperimentRow } from '../api-types';
import { Ago, CheatingBadge, LoadState, MockBadge, OutcomeBadge, PassBadge } from '../components';
import { fmtDuration, fmtPct, fmtScore, fmtTokens, fmtUsd } from '../format';

type Key = keyof ExperimentRow;

const COLUMNS: { key: Key; label: string; num?: boolean }[] = [
  { key: 'id', label: 'Experiment' },
  { key: 'taskId', label: 'Task' },
  { key: 'createdAt', label: 'Created' },
  { key: 'model', label: 'Model' },
  { key: 'configId', label: 'Config' },
  { key: 'passed', label: 'Pass/fail' },
  { key: 'outcome', label: 'Outcome' },
  { key: 'medianTokens', label: 'Tokens (median)', num: true },
  { key: 'costUsd', label: 'API-equiv. cost', num: true },
  { key: 'medianDurationMs', label: 'Runtime', num: true },
  { key: 'visualScore', label: 'Visual', num: true },
  { key: 'improvementVsBestPct', label: 'vs best', num: true },
];

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1; // nulls last
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a ? -1 : 1;
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

export function ExperimentsSection() {
  const state = useApi<{ experiments: ExperimentRow[] }>('/api/experiments');
  const [sort, setSort] = useState<{ key: Key; dir: 1 | -1 }>({ key: 'createdAt', dir: -1 });
  const [filter, setFilter] = useState('');
  const [task, setTask] = useState('');

  const tasks = useMemo(() => [...new Set((state.data?.experiments ?? []).map((r) => r.taskId ?? 'todo'))].sort((a, b) => (a === 'todo' ? -1 : b === 'todo' ? 1 : a.localeCompare(b))), [state.data]);

  const rows = useMemo(() => {
    const list = (state.data?.experiments ?? []).filter((r) => !task || (r.taskId ?? 'todo') === task);
    const f = filter.trim().toLowerCase();
    const filtered = f
      ? list.filter((r) => [r.id, r.taskId, r.model, r.configId, r.outcome, r.hypothesis].some((v) => v && String(v).toLowerCase().includes(f)))
      : list;
    return [...filtered].sort((a, b) => {
      const c = compare(a[sort.key], b[sort.key]);
      // keep nulls last regardless of direction
      if (a[sort.key] == null || b[sort.key] == null) return c;
      return c * sort.dir;
    });
  }, [state.data, sort, filter, task]);

  const clickHeader = (key: Key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  const total = state.data?.experiments.length ?? 0;
  return (
    <section className="ds-section" aria-label="Experiments">
      <div className="ds-section__head">
        <h2 className="ds-section__title">All experiments</h2>
        <p className="ds-section__meta">
          {rows.length === total ? `${total} experiments` : `${rows.length} of ${total} shown`} · newest first by default
        </p>
      </div>
      <div className="ds-filters">
        <select className="ds-select" aria-label="Task" value={task} onChange={(e) => setTask(e.target.value)}>
          <option value="">All tasks</option>
          {tasks.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input className="ds-input" style={{ flex: '1 1 260px' }} placeholder="Filter by id, task, model, config, outcome, hypothesis…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <LoadState state={state}>
        {() =>
          rows.length === 0 ? (
            <div className="ds-table-wrap">
              <p className="ds-empty">{total ? 'No experiment matches this filter.' : 'No experiments have been recorded yet. Start one with npm run research.'}</p>
            </div>
          ) : (
            <div className="ds-table-wrap">
              <table className="ds-table ds-table--hover ds-table--clickable">
                <thead>
                  <tr>
                    {COLUMNS.map((c) => (
                      <th
                        key={c.key}
                        className={(c.num ? 'num ' : '') + 'sortable'}
                        onClick={() => clickHeader(c.key)}
                        aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
                      >
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} onClick={() => (window.location.hash = `#/experiments/${r.id}`)}>
                      <td className="nowrap">
                        <a className="ds-link mono" href={`#/experiments/${r.id}`}>
                          {r.id}
                        </a>
                        {(r.isMock || r.cheating) && (
                          <span className="pills">
                            <MockBadge show={r.isMock} /> <CheatingBadge cheating={r.cheating} />
                          </span>
                        )}
                      </td>
                      <td className="mono dim nowrap">{r.taskId ?? 'todo'}</td>
                      <td className="num dim nowrap">
                        <Ago iso={r.createdAt} />
                      </td>
                      <td className="dim nowrap">{r.model}</td>
                      <td className="mono dim cfg">{r.configId}</td>
                      <td className="nowrap">
                        <PassBadge passed={r.passed} label={r.passed === null ? r.status : undefined} />
                        {r.runs > 0 && <span className="num dim"> {r.passes}/{r.runs}</span>}
                      </td>
                      <td>
                        <OutcomeBadge outcome={r.outcome} />
                      </td>
                      <td className="num">{fmtTokens(r.medianTokens)}</td>
                      <td className="num">{fmtUsd(r.costUsd)}</td>
                      <td className="num">{fmtDuration(r.medianDurationMs)}</td>
                      <td className="num">{fmtScore(r.visualScore)}</td>
                      <td className={'num ' + (r.improvementVsBestPct === null || r.passed !== true ? 'ds-muted' : r.improvementVsBestPct >= 0 ? 'ds-pos' : 'ds-neg')}>
                        {r.improvementVsBestPct === 0 ? 'best' : fmtPct(r.improvementVsBestPct, true)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </LoadState>
      <p className="ds-note">
        Tokens are the median coding-agent tokens across an experiment's runs. "vs best" is the saving against the current best verified median
        of the experiment's own task (bests are per task): positive means fewer tokens than the best. Mock rows compare against the mock best.
      </p>
    </section>
  );
}
