/** The tabbed panel's contents: dense, selectable tables. Selecting a row shows it in the detail panel. */
import { useMemo, useState } from 'react';
import type { SessionDetail } from '../../server/src/session-detail';
import type { Lab } from './lab';
import { SuggestionsTab } from './suggestions';
import { formatDur, formatStamp, formatTokens, formatUsd } from './format';
import { CellBar, Row, StackedBar } from './parts';
import { sameSel, titleOf, turnLabel, type Selection, type Tab } from './view';

export interface TabProps {
  d: SessionDetail;
  sel: Selection | null;
  select: (kind: Selection['kind'], key: string) => void;
  lab: Lab;
}

const tokenTotal = (t: { input: number; output: number; cacheRead: number; cacheWrite: number }) => t.input + t.output + t.cacheRead + t.cacheWrite;

export function TabBody({ tab, ...p }: TabProps & { tab: Tab }) {
  if (tab === 'sessions') return <SessionsTab {...p} />;
  if (tab === 'usage') return <UsageTab {...p} />;
  if (tab === 'suggestions') return <SuggestionsTab lab={p.lab} sel={p.sel} select={p.select} />;
  return <ConvoTab {...p} />;
}

/** Row counts shown on the tab labels. */
export function tabCount(d: SessionDetail, tab: Tab): number | null {
  if (tab === 'sessions') return d.childrenTotal.sessions;
  if (tab === 'convo') return d.turns.length;
  return null;
}

function SessionsTab({ d, sel, select }: TabProps) {
  if (!d.children.length) return <p className="pad dim">This session didn't launch any other sessions.</p>;
  const max = Math.max(...d.children.map((c) => c.costUsd));
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Started</th>
          <th>Session</th>
          <th>Folder</th>
          <th className="r">Ran</th>
          <th className="r">Cost</th>
          <th className="bar-col" />
          <th className="r">Tokens</th>
        </tr>
      </thead>
      <tbody>
        {d.children.map((c) => (
          <Row key={c.id} selected={sameSel(sel, 'child', c.id)} onSelect={() => select('child', c.id)}>
            <td className="num nowrap dim">{formatStamp(c.start)}</td>
            <td className="ellipsis">
              {titleOf(c)}
              {c.parentLink === 'timing' && <span className="chip guess">timing</span>}
              {c.descendants > 0 && <span className="chip">+{c.descendants}</span>}
            </td>
            <td className="ellipsis mono dim">{c.folder ?? '—'}</td>
            <td className="r num">{c.start && c.end ? formatDur(Date.parse(c.end) - Date.parse(c.start)) : '—'}</td>
            <td className="r num">{formatUsd(c.costUsd)}</td>
            <td className="bar-col">
              <CellBar value={c.costUsd} max={max} />
            </td>
            <td className="r num">{formatTokens(c.tokens)}</td>
          </Row>
        ))}
      </tbody>
    </table>
  );
}

function ConvoTab({ d, sel, select }: TabProps) {
  if (!d.turns.length) return <p className="pad dim">No prompts were recorded for this session.</p>;
  const maxCost = Math.max(...d.turns.map((t) => t.costUsd));
  return (
    <table className="grid">
      <thead>
        <tr>
          <th className="r">#</th>
          <th>Time</th>
          <th>From</th>
          <th>Prompt</th>
          <th className="r">Dur</th>
          <th className="r">Cost</th>
          <th className="bar-col" />
          <th className="r">Tok</th>
          <th className="r">Tools</th>
        </tr>
      </thead>
      <tbody>
        {d.turns.map((t, i) => {
          const failed = t.items.filter((x) => (x.kind === 'tool' && !x.success) || x.kind === 'error').length;
          return (
            <Row key={t.promptId} selected={sameSel(sel, 'turn', t.promptId)} onSelect={() => select('turn', t.promptId)} title={t.promptLabel ?? undefined}>
              <td className="r num dim">{i + 1}</td>
              <td className="num nowrap dim">{formatStamp(t.ts)}</td>
              <td className={`nowrap from-${t.promptKind}`}>{t.promptKind === 'user' ? 'you' : t.promptKind === 'task' ? 'task' : 'msg'}</td>
              <td className="ellipsis wide">{turnLabel(t)}</td>
              <td className="r num">{formatDur(t.durationMs)}</td>
              <td className="r num">{formatUsd(t.costUsd)}</td>
              <td className="bar-col">
                <CellBar value={t.costUsd} max={maxCost} />
              </td>
              <td className="r num dim">{formatTokens(tokenTotal(t.tokens))}</td>
              <td className="r num">
                {t.toolCalls}
                {failed > 0 && <span className="down"> ✕{failed}</span>}
              </td>
            </Row>
          );
        })}
      </tbody>
    </table>
  );
}

type SortKey = 'time' | 'tokens' | 'cost';
const SORT_LABEL: Record<SortKey, string> = { time: 'Time', tokens: 'Tokens', cost: 'Cost' };

/** Time and cost together: where it went, then every turn, sortable by time, tokens or cost. */
function UsageTab({ d, sel, select }: TabProps) {
  const t = d.time;
  const tot = d.totals;
  const all = tokenTotal(tot);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'time', desc: true });
  const value = (x: SessionDetail['turns'][number]) => (sort.key === 'time' ? x.durationMs : sort.key === 'tokens' ? tokenTotal(x.tokens) : x.costUsd);
  const rows = useMemo(() => {
    const v = (x: SessionDetail['turns'][number]) => (sort.key === 'time' ? x.durationMs : sort.key === 'tokens' ? tokenTotal(x.tokens) : x.costUsd);
    return d.turns.map((turn, i) => ({ turn, n: i + 1 })).sort((a, b) => (v(a.turn) - v(b.turn)) * (sort.desc ? -1 : 1));
  }, [d, sort]);
  const max = Math.max(...d.turns.map(value), 0);
  const header = (key: SortKey) => (
    <th className="r">
      <button
        className={`sort${sort.key === key ? ' active' : ''}`}
        aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}
        onClick={() => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: true }))}
      >
        {SORT_LABEL[key]}
        {sort.key === key ? (sort.desc ? ' ▾' : ' ▴') : ''}
      </button>
    </th>
  );
  return (
    <div className="pad">
      <div className="block-title">Working time</div>
      <StackedBar
        label="Working time"
        total={t.workingMs}
        format={formatDur}
        segments={[
          { key: 'model', label: 'Model', value: t.modelMs, color: 'var(--series-1)' },
          { key: 'tools', label: 'Tools', value: t.toolMs, color: 'var(--series-2)' },
          { key: 'permission', label: 'Permission prompts', value: t.permissionMs, color: 'var(--series-3)' },
        ]}
      />
      <div className="block-title">Tokens</div>
      <StackedBar
        label="Tokens"
        total={all}
        format={formatTokens}
        segments={[
          { key: 'cacheRead', label: 'Cache read', value: tot.cacheRead, color: 'var(--series-1)' },
          { key: 'cacheWrite', label: 'Cache write', value: tot.cacheWrite, color: 'var(--series-2)' },
          { key: 'input', label: 'Input', value: tot.input, color: 'var(--series-3)' },
          { key: 'output', label: 'Output', value: tot.output, color: 'var(--series-4)' },
        ]}
      />

      <div className="block-title">
        Turns <span className="dim">by {SORT_LABEL[sort.key].toLowerCase()}</span>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th className="r">#</th>
            <th>Prompt</th>
            {header('time')}
            {header('tokens')}
            {header('cost')}
            <th className="bar-col" />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ turn, n }) => (
            <Row key={turn.promptId} selected={sameSel(sel, 'turn', turn.promptId)} onSelect={() => select('turn', turn.promptId)} title={turn.promptLabel ?? undefined}>
              <td className="r num dim">{n}</td>
              <td className={`ellipsis wide${turn.promptKind === 'user' ? '' : ' from-task'}`}>{turnLabel(turn)}</td>
              <td className={`r num${sort.key === 'time' ? ' strong' : ''}`}>{formatDur(turn.durationMs)}</td>
              <td className={`r num${sort.key === 'tokens' ? ' strong' : ''}`}>{formatTokens(tokenTotal(turn.tokens))}</td>
              <td className={`r num${sort.key === 'cost' ? ' strong' : ''}`}>{formatUsd(turn.costUsd)}</td>
              <td className="bar-col">
                <CellBar value={value(turn)} max={max} />
              </td>
            </Row>
          ))}
        </tbody>
      </table>

    </div>
  );
}
