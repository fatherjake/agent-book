/** Small pieces shared by the tabs and the detail panel. */
import { useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Item } from '../../server/src/session-detail';
import { formatClock, formatDur, formatPercent, formatTokens } from './format';

/** Long text, cut to a few lines until expanded. */
export function Clamp({ text, lines }: { text: string; lines: number }) {
  const [open, setOpen] = useState(false);
  const long = text.split('\n').length > lines || text.length > lines * 140;
  return (
    <>
      <div className={open || !long ? 'text' : 'text clamped'} style={{ WebkitLineClamp: open ? undefined : lines }}>
        {text}
      </div>
      {long && (
        <button className="link-button" onClick={() => setOpen(!open)}>
          {open ? 'less' : 'more'}
        </button>
      )}
    </>
  );
}

/**
 * Claude's replies are GitHub-flavoured Markdown (headings, tables, fenced code, lists). Raw HTML in them
 * is shown as text, never rendered, and links open in a new tab.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Markdown cut to a height until expanded. */
export function ClampMarkdown({ text, lines }: { text: string; lines: number }) {
  const [open, setOpen] = useState(false);
  const long = text.split('\n').length > lines || text.length > lines * 140;
  return (
    <>
      <div className={open || !long ? undefined : 'md-clamped'} style={open || !long ? undefined : { maxHeight: `${lines * 1.45}em` }}>
        <Markdown text={text} />
      </div>
      {long && (
        <button className="link-button" onClick={() => setOpen(!open)}>
          {open ? 'less' : 'more'}
        </button>
      )}
    </>
  );
}

/** A tool call's output, fetched when shown. */
export function ToolOutput({ id }: { id: string }) {
  const [out, setOut] = useState<{ state: 'loading' } | { state: 'done'; text: string | null }>({ state: 'loading' });
  useEffect(() => {
    let alive = true;
    setOut({ state: 'loading' });
    fetch(`/api/tool-output/${id}`)
      .then((r) => r.json())
      .then((b) => alive && setOut({ state: 'done', text: b.output ?? null }))
      .catch(() => alive && setOut({ state: 'done', text: null }));
    return () => {
      alive = false;
    };
  }, [id]);
  if (out.state === 'loading') return <p className="dim small">Loading output…</p>;
  return out.text ? <pre className="code output">{out.text}</pre> : <p className="dim small">No output recorded.</p>;
}

type ToolItem = Extract<Item, { kind: 'tool' }>;
type SubagentItem = Extract<Item, { kind: 'subagent' }>;

export function ToolRow({ item, onOpen }: { item: ToolItem; onOpen?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tool">
      <button className="tool-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tool-name">{item.name}</span>
        <span className="tool-label">{item.label || '—'}</span>
        {!item.success && <span className="down small">failed</span>}
        <span className="dim num nowrap">{formatDur(item.durationMs)}</span>
      </button>
      {open && (
        <div className="tool-detail">
          <div className="dim small">
            {formatClock(item.ts)}
            {onOpen && item.id && (
              <>
                {' · '}
                <button className="link-button" onClick={() => onOpen(item.id!)}>
                  select
                </button>
              </>
            )}
          </div>
          {item.input && <pre className="code">{item.input}</pre>}
          {item.hasOutput && item.id && <ToolOutput id={item.id} />}
        </div>
      )}
    </div>
  );
}

export function SubagentRow({ item, onOpen }: { item: SubagentItem; onOpen?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const tools = item.items.filter((i) => i.kind === 'tool').length;
  const n = item.toolUses ?? tools;
  return (
    <div className="tool subagent">
      <button className="tool-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tool-name">Subagent</span>
        <span className="tool-label">
          {item.agentType ?? 'agent'} · {n} tool call{n === 1 ? '' : 's'}
          {item.tokens != null && ` · ${formatTokens(item.tokens)} tok`}
          {!item.done && ' · did not report back'}
        </span>
        <span className="dim num nowrap">{formatDur(item.durationMs)}</span>
      </button>
      {open && (item.items.length ? <ItemList items={item.items} onOpen={onOpen} /> : <p className="dim small tool-detail">Its steps weren't recorded.</p>)}
    </div>
  );
}

export function Marker({ item }: { item: Item }) {
  if (item.kind === 'compaction')
    return (
      <div className="marker">
        Context compacted{item.trigger ? ` (${item.trigger})` : ''}: {item.preTokens != null ? formatTokens(item.preTokens) : '?'} → {item.postTokens != null ? formatTokens(item.postTokens) : '?'} tokens
        {item.durationMs != null && `, ${formatDur(item.durationMs)}`}
      </div>
    );
  if (item.kind === 'mode')
    return (
      <div className="marker">
        Permission mode: {item.from ?? '?'} → {item.to ?? '?'}
      </div>
    );
  if (item.kind === 'error') return <div className="marker down">API error: {item.text}</div>;
  if (item.kind === 'skill') return <div className="marker">Skill: {item.name}</div>;
  return null;
}

export function ItemList({ items, onOpen }: { items: Item[]; onOpen?: (id: string) => void }) {
  return (
    <ol className="items">
      {items.map((item, i) => (
        <li key={i}>
          {item.kind === 'tool' ? (
            <ToolRow item={item} onOpen={onOpen} />
          ) : item.kind === 'subagent' ? (
            <SubagentRow item={item} onOpen={onOpen} />
          ) : item.kind === 'response' ? (
            <div className="item-text">
              <ClampMarkdown text={item.text} lines={6} />
            </div>
          ) : (
            <Marker item={item} />
          )}
        </li>
      ))}
    </ol>
  );
}

/** A unified diff, its added and removed lines tinted. */
export function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="code diff">
      {diff.split('\n').map((l, i) => (
        <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'diff-add' : l.startsWith('-') && !l.startsWith('---') ? 'diff-del' : l.startsWith('@@') ? 'diff-hunk' : undefined}>
          {l + '\n'}
        </span>
      ))}
    </pre>
  );
}

export interface Segment {
  key: string;
  label: string;
  value: number;
  color: string;
}

/** A single stacked bar with a legend carrying the values, so colour is never the only label. */
export function StackedBar({ segments, total, label, format }: { segments: Segment[]; total: number; label: string; format: (v: number) => string }) {
  const parts = segments.filter((s) => s.value > 0);
  return (
    <figure className="stack">
      <div className="stack-bar" role="img" aria-label={`${label}: ${parts.map((s) => `${s.label} ${format(s.value)}`).join(', ')}`}>
        {parts.map((s) => (
          <div key={s.key} className="stack-seg" style={{ flexGrow: s.value, background: s.color }} title={`${s.label}: ${format(s.value)} (${formatPercent(s.value, total)})`} />
        ))}
      </div>
      <ul className="legend">
        {segments.map((s) => (
          <li key={s.key}>
            <span className="swatch" style={{ background: s.color }} />
            <span className="dim">{s.label}</span>
            <span className="num strong">{format(s.value)}</span>
            <span className="num dim">{formatPercent(s.value, total)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** An inline bar for a table cell, scaled to the column's largest value. */
export function CellBar({ value, max }: { value: number; max: number }) {
  return (
    <span className="cell-bar" aria-hidden>
      <span style={{ width: `${max > 0 ? Math.max(1, (value / max) * 100) : 0}%` }} />
    </span>
  );
}

/** A selectable table row. */
export function Row({ selected, onSelect, children, title, className }: { selected: boolean; onSelect: () => void; children: ReactNode; title?: string; className?: string }) {
  return (
    <tr
      className={[selected ? 'sel' : '', className ?? ''].filter(Boolean).join(' ') || undefined}
      tabIndex={0}
      title={title}
      aria-selected={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
        // Up/down moves the selection along the table, terminal-style.
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const row = e.currentTarget;
          const next = (e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling) as HTMLTableRowElement | null;
          if (next) {
            next.focus();
            next.click();
          }
        }
      }}
    >
      {children}
    </tr>
  );
}
