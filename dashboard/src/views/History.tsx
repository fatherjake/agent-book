import { useMemo, useState } from 'react';
import { useApi } from '../api';
import type { ExperimentRow } from '../api-types';
import { CheatingBadge, LoadState, MockBadge, NoBrowserBadge, OutcomeBadge, PassBadge } from '../components';
import { fmtDate, fmtDuration, fmtPct, fmtScore, fmtTokens, fmtUsd } from '../format';

type Key = keyof ExperimentRow;

const COLUMNS: { key: Key; label: string; num?: boolean }[] = [
  { key: 'id', label: 'Experiment' },
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

export function HistoryView() {
  const state = useApi<{ experiments: ExperimentRow[] }>('/api/experiments');
  const [sort, setSort] = useState<{ key: Key; dir: 1 | -1 }>({ key: 'createdAt', dir: -1 });
  const [filter, setFilter] = useState('');

  const rows = useMemo(() => {
    const list = state.data?.experiments ?? [];
    const f = filter.trim().toLowerCase();
    const filtered = f
      ? list.filter((r) => [r.id, r.model, r.configId, r.outcome, r.hypothesis].some((v) => v && String(v).toLowerCase().includes(f)))
      : list;
    return [...filtered].sort((a, b) => {
      const c = compare(a[sort.key], b[sort.key]);
      // keep nulls last regardless of direction
      if (a[sort.key] == null || b[sort.key] == null) return c;
      return c * sort.dir;
    });
  }, [state.data, sort, filter]);

  const clickHeader = (key: Key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  return (
    <>
      <div className="row-between">
        <h1>Experiment history</h1>
        <input className="search" placeholder="Filter by id, model, config, hypothesis…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <LoadState state={state}>
        {() =>
          rows.length === 0 ? (
            <div className="empty">No experiments recorded yet.</div>
          ) : (
            <div className="table-wrap">
              <table className="table sortable">
                <thead>
                  <tr>
                    {COLUMNS.map((c) => (
                      <th
                        key={c.key}
                        className={c.num ? 'num' : ''}
                        onClick={() => clickHeader(c.key)}
                        aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                      >
                        {c.label}
                        <span className="sort-ind">{sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => (window.location.hash = `#/experiments/${r.id}`)}>
                      <td>
                        <a href={`#/experiments/${r.id}`}>{r.id}</a> <MockBadge show={r.isMock} /> <NoBrowserBadge show={r.noBrowserAgent} /> <CheatingBadge cheating={r.cheating} />
                      </td>
                      <td className="nowrap">{fmtDate(r.createdAt)}</td>
                      <td>{r.model}</td>
                      <td className="mono">{r.configId}</td>
                      <td>
                        <PassBadge passed={r.passed} label={r.passed === null ? r.status : undefined} />
                        {r.runs > 0 && <span className="muted small"> {r.passes}/{r.runs}</span>}
                      </td>
                      <td>
                        <OutcomeBadge outcome={r.outcome} />
                      </td>
                      <td className="num">{fmtTokens(r.medianTokens)}</td>
                      <td className="num">{fmtUsd(r.costUsd)}</td>
                      <td className="num">{fmtDuration(r.medianDurationMs)}</td>
                      <td className="num">{fmtScore(r.visualScore)}</td>
                      <td className={'num ' + (r.improvementVsBestPct === null || r.passed !== true ? 'muted' : r.improvementVsBestPct >= 0 ? 'good' : 'bad')}>
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
      <p className="muted small">
        Tokens are the median coding-agent tokens across the experiment's runs. "vs best" is the token saving relative to
        the current best verified median (positive = fewer tokens than the best; mock rows compare against the mock best).
      </p>
    </>
  );
}
