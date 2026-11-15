/**
 * Viewer for results/runs/<id>/trace.jsonl. The format is tolerant: entries
 * are grouped into turns by a numeric `turn` field when present; anything that
 * looks like a tool call (has a tool name + input/output) gets a collapsible
 * call block, and everything else is shown as a collapsible JSON event.
 */
import { useMemo, useState } from 'react';
import type { TraceEntry } from './api-types';

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function kindOf(e: TraceEntry): string {
  return str(e.type) ?? str(e.kind) ?? str(e.event) ?? 'event';
}

function toolName(e: TraceEntry): string | undefined {
  return str(e.tool) ?? str(e.toolName) ?? (/tool/i.test(kindOf(e)) ? str(e.name) : undefined);
}

function pretty(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function summary(e: TraceEntry): string {
  const t = str(e.text) ?? str(e.message) ?? str(e.summary) ?? str(e.content);
  if (t) return t.replace(/\s+/g, ' ').slice(0, 140);
  const input = e.input ?? e.args ?? e.arguments;
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const first = str(o.command) ?? str(o.path) ?? str(o.file);
    if (first) return first.slice(0, 140);
  }
  return '';
}

function Entry({ e, defaultOpen }: { e: TraceEntry; defaultOpen: boolean }) {
  const tool = toolName(e);
  const kind = kindOf(e);
  const isError = e.isError === true || e.error !== undefined || e.ok === false;
  const output = e.output ?? e.result ?? e.content;
  const input = e.input ?? e.args ?? e.arguments;
  return (
    <details className={'trace-entry ' + (tool ? 'tool' : 'event') + (isError ? ' err' : '')} open={defaultOpen}>
      <summary>
        <span className="trace-kind">{tool ? 'tool' : kind}</span>
        {tool && <span className="mono strong">{tool}</span>}
        {typeof e.durationMs === 'number' && <span className="muted small">{Math.round(e.durationMs)}ms</span>}
        {isError && <span className="badge fail">error</span>}
        <span className="trace-sum">{summary(e)}</span>
      </summary>
      {tool ? (
        <div className="trace-body">
          {input !== undefined && (
            <>
              <div className="trace-label">input</div>
              <pre>{pretty(input)}</pre>
            </>
          )}
          {output !== undefined && (
            <>
              <div className="trace-label">output</div>
              <pre>{pretty(output)}</pre>
            </>
          )}
          {e.error !== undefined && (
            <>
              <div className="trace-label">error</div>
              <pre>{pretty(e.error)}</pre>
            </>
          )}
        </div>
      ) : (
        <div className="trace-body">
          {typeof e.text === 'string' && <p className="prose trace-text">{e.text}</p>}
          <pre>{pretty(typeof e.text === 'string' ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'text')) : e)}</pre>
        </div>
      )}
    </details>
  );
}

export function TraceViewer({ entries, truncated, totalLines }: { entries: TraceEntry[]; truncated: boolean; totalLines: number }) {
  const [filter, setFilter] = useState('');
  const [expandAll, setExpandAll] = useState(false);
  const [onlyTools, setOnlyTools] = useState(false);

  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = entries.filter((e) => (!onlyTools || toolName(e)) && (!f || JSON.stringify(e).toLowerCase().includes(f)));
    const out: { turn: number | null; items: TraceEntry[] }[] = [];
    for (const e of list) {
      const turn = typeof e.turn === 'number' ? e.turn : null;
      const last = out[out.length - 1];
      if (last && last.turn === turn && turn !== null) last.items.push(e);
      else out.push({ turn, items: [e] });
    }
    return out;
  }, [entries, filter, onlyTools]);

  if (!entries.length) return <div className="empty">No trace recorded for this run.</div>;
  const toolCount = entries.filter((e) => toolName(e)).length;

  return (
    <div className="trace">
      <div className="row-between trace-controls">
        <input className="search" placeholder="Search trace…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="small">
          <input type="checkbox" checked={onlyTools} onChange={(e) => setOnlyTools(e.target.checked)} /> Tool calls only
        </label>
        <button onClick={() => setExpandAll((v) => !v)}>{expandAll ? 'Collapse all' : 'Expand all'}</button>
        <span className="muted small">
          {entries.length} entries · {toolCount} tool calls{truncated ? ` · showing first ${entries.length} of ${totalLines} lines` : ''}
        </span>
      </div>
      {groups.map((g, gi) =>
        g.turn === null ? (
          g.items.map((e, i) => <Entry key={`${gi}-${i}-${expandAll}`} e={e} defaultOpen={expandAll} />)
        ) : (
          <details key={`${gi}-${expandAll}`} className="trace-turn" open={expandAll || groups.length <= 3}>
            <summary>
              <b>Turn {g.turn}</b> <span className="muted small">{g.items.length} entries · {g.items.filter((e) => toolName(e)).length} tool calls</span>{' '}
              <span className="trace-sum">{summary(g.items.find((e) => !toolName(e)) ?? g.items[0])}</span>
            </summary>
            {g.items.map((e, i) => (
              <Entry key={`${i}-${expandAll}`} e={e} defaultOpen={expandAll} />
            ))}
          </details>
        ),
      )}
    </div>
  );
}
