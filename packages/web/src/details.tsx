/** The detail panel: everything about the selected row. */
import type { ReactNode } from 'react';
import type { Item, SessionDetail } from '../../server/src/session-detail';
import type { Lab } from './lab';
import { SuggestionDetail } from './suggestions';
import { formatDur, formatStamp, formatTokens, formatUsd } from './format';
import { Clamp, ClampMarkdown, ItemList, Marker, ToolOutput } from './parts';
import { findTool, findTurn, titleOf, toHash, turnLabel, type Selection } from './view';

interface Props {
  d: SessionDetail;
  sel: Selection | null;
  select: (kind: Selection['kind'], key: string) => void;
  lab: Lab;
}


/** Label/value pairs in two dense columns. */
function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function detailTitle(d: SessionDetail, sel: Selection | null): string {
  if (!sel) return 'Detail';
  if (sel.kind === 'turn') return `Turn #${findTurn(d, sel.key)?.n ?? '?'}`;
  if (sel.kind === 'tool') return `Tool call · ${findTool(d, sel.key)?.tool.name ?? ''}`;
  if (sel.kind === 'suggestion') return sel.key === 'baseline' ? 'Baseline' : 'Suggestion';
  return 'Launched session';
}

/** Previous / next for a selected turn, shown in the detail panel's header. */
export function DetailNav({ d, sel, select }: { d: SessionDetail; sel: Selection | null; select: Props['select'] }) {
  if (sel?.kind !== 'turn') return null;
  const hit = findTurn(d, sel.key);
  if (!hit) return null;
  const prev = d.turns[hit.n - 2];
  const next = d.turns[hit.n];
  return (
    <span className="detail-nav">
      <button className="link-button" disabled={!prev} onClick={() => prev && select('turn', prev.promptId)} title="Previous turn">
        ← prev
      </button>
      <span className="num dim">
        {hit.n}/{d.turns.length}
      </span>
      <button className="link-button" disabled={!next} onClick={() => next && select('turn', next.promptId)} title="Next turn">
        next →
      </button>
    </span>
  );
}

export function Detail({ d, sel, select, lab }: Props) {
  if (!sel) return <Empty />;
  if (sel.kind === 'suggestion') return <SuggestionDetail lab={lab} id={sel.key} />;
  if (sel.kind === 'turn') return <TurnDetail d={d} id={sel.key} select={select} />;
  if (sel.kind === 'tool') return <ToolDetail d={d} id={sel.key} select={select} />;
  if (sel.kind === 'child') {
    const c = d.children.find((x) => x.id === sel.key);
    if (!c) return <Gone />;
    return (
      <div className="pad">
        <div className="detail-title">{titleOf(c)}</div>
        {c.summary && <p className="recap">{c.summary}</p>}
        <Facts
          rows={[
            ['Folder', <span className="mono">{c.folder ?? '—'}</span>],
            ['Started', formatStamp(c.start)],
            ['Ran for', c.start && c.end ? formatDur(Date.parse(c.end) - Date.parse(c.start)) : '—'],
            ['Cost', formatUsd(c.costUsd)],
            ['Tokens', formatTokens(c.tokens)],
            ['Prompts', c.prompts],
            ['Linked by', c.parentLink === 'timing' ? 'timing (a best guess)' : c.parentLink === 'path' ? 'folder path' : 'launch record'],
            ['Launched', c.descendants ? `${c.descendants} more` : 'none'],
          ]}
        />
        {c.firstPrompt && (
          <>
            <div className="block-title">First prompt</div>
            <Clamp text={c.firstPrompt} lines={10} />
          </>
        )}
        <p>
          <a className="button" href={toHash({ id: c.id, tab: 'convo', sel: null })}>
            Open session →
          </a>
        </p>
      </div>
    );
  }
  return <Gone />;
}

const Gone = () => <p className="pad dim">That item isn't in this session any more.</p>;

/** Only when the session has no turns to select. */
const Empty = () => <p className="pad dim">Nothing selected.</p>;

function TurnDetail({ d, id, select }: { d: SessionDetail; id: string; select: Props['select'] }) {
  const hit = findTurn(d, id);
  if (!hit) return <Gone />;
  const t = hit.turn;
  return (
    <div className="pad">
      <div className={`bubble ${t.promptKind === 'user' ? 'you' : 'notice'}`}>
        <div className="who">{t.promptKind === 'user' ? 'You' : t.promptKind === 'task' ? 'Background task' : 'Message'}</div>
        {t.promptKind === 'user' ? t.prompt ? <Clamp text={t.prompt} lines={12} /> : <span className="dim">(prompt not recorded)</span> : <div className="text">{turnLabel(t)}</div>}
      </div>
      <Timeline items={t.items} select={select} />
    </div>
  );
}

/** A turn's steps: replies in full, runs of tool calls as lists. */
function Timeline({ items, select }: { items: Item[]; select: Props['select'] }) {
  const blocks: ({ kind: 'item'; item: Item } | { kind: 'run'; items: Item[] })[] = [];
  for (const item of items) {
    const inRun = item.kind === 'tool' || item.kind === 'subagent' || item.kind === 'error' || item.kind === 'skill';
    const last = blocks[blocks.length - 1];
    if (inRun && last?.kind === 'run') last.items.push(item);
    else if (inRun) blocks.push({ kind: 'run', items: [item] });
    else blocks.push({ kind: 'item', item });
  }
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === 'run' ? (
          <ItemList key={i} items={b.items} onOpen={(id) => select('tool', id)} />
        ) : b.item.kind === 'response' ? (
          <div key={i} className="bubble claude">
            <div className="who">Claude</div>
            <ClampMarkdown text={b.item.text} lines={30} />
          </div>
        ) : (
          <Marker key={i} item={b.item} />
        ),
      )}
    </>
  );
}

function ToolDetail({ d, id, select }: { d: SessionDetail; id: string; select: Props['select'] }) {
  const hit = findTool(d, id);
  if (!hit) return <Gone />;
  const t = hit.tool;
  return (
    <div className="pad">
      <div className="detail-title">{t.label || t.name}</div>
      <Facts
        rows={[
          ['Tool', <span className="mono">{t.name}</span>],
          ['When', formatStamp(t.ts)],
          ['Took', formatDur(t.durationMs)],
          ['Result', t.success ? <span className="up">ok</span> : <span className="down">failed</span>],
          [
            'Turn',
            <button className="link-button" onClick={() => select('turn', hit.turn.promptId)}>
              #{hit.n} {turnLabel(hit.turn).slice(0, 60)}
            </button>,
          ],
        ]}
      />
      {t.input && (
        <>
          <div className="block-title">Input</div>
          <pre className="code">{t.input}</pre>
        </>
      )}
      <div className="block-title">Output</div>
      {t.hasOutput ? <ToolOutput id={id} /> : <p className="dim small">No output recorded.</p>}
    </div>
  );
}

