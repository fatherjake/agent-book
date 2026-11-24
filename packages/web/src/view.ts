/**
 * What is on screen: the open session, its tab and the selected item. It lives in the URL hash
 * (`#/session/<id>/<tab>/<kind>:<key>`) so a reload or a shared link opens the same view, and it is
 * described in words for the page chat.
 */
import type { Item, SessionDetail, Turn } from '../../server/src/session-detail';
import type { SessionSummary } from '../../server/src/sessions';
import { firstLine, formatMs, formatTokens, formatUsd } from './format';

export const TABS = [
  { id: 'convo', label: 'Convo' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'usage', label: 'Usage' },
] as const;
export type Tab = (typeof TABS)[number]['id'];

export type Selection =
  | { kind: 'turn'; key: string }
  | { kind: 'tool'; key: string }
  | { kind: 'child'; key: string };

export interface View {
  id: string | null;
  tab: Tab;
  sel: Selection | null;
}

const KINDS = new Set(['turn', 'tool', 'child']);

export function parseHash(hash: string): View {
  const m = hash.match(/^#\/session\/([0-9a-f-]{36})(?:\/([a-z]+))?(?:\/([a-z]+):(.+))?$/);
  if (!m) return { id: null, tab: 'convo', sel: null };
  // time and cost were merged into usage (old links land there); changes was dropped (falls to convo).
  const name = m[2] === 'time' || m[2] === 'cost' ? 'usage' : m[2];
  const tab = (TABS.some((t) => t.id === name) ? name : 'convo') as Tab;
  const sel = m[3] && KINDS.has(m[3]) ? ({ kind: m[3], key: decodeURIComponent(m[4]) } as Selection) : null;
  return { id: m[1], tab, sel };
}

export function toHash(v: View): string {
  if (!v.id) return '#/';
  return `#/session/${v.id}/${v.tab}${v.sel ? `/${v.sel.kind}:${encodeURIComponent(v.sel.key)}` : ''}`;
}

export const sameSel = (a: Selection | null, kind: Selection['kind'], key: string) => a?.kind === kind && a.key === key;

export const titleOf = (s: SessionSummary) => s.title ?? firstLine(s.firstPrompt) ?? 'Untitled session';

/** A turn in one line: the prompt, or what woke Claude up. */
export function turnLabel(t: { promptKind: Turn['promptKind']; promptLabel: string | null }): string {
  if (t.promptKind === 'task') return t.promptLabel?.startsWith('Background') ? t.promptLabel : `Background task: ${t.promptLabel ?? ''}`;
  if (t.promptKind === 'message') return `Message: ${t.promptLabel ?? ''}`;
  return t.promptLabel ?? '(no prompt)';
}

type ToolItem = Extract<Item, { kind: 'tool' }>;

/** A tool call by its id, wherever it sits (subagents included), with the turn it belongs to. */
export function findTool(d: SessionDetail, id: string): { tool: ToolItem; turn: Turn; n: number } | null {
  const walk = (items: Item[]): ToolItem | null => {
    for (const i of items) {
      if (i.kind === 'tool' && i.id === id) return i;
      if (i.kind === 'subagent') {
        const hit = walk(i.items);
        if (hit) return hit;
      }
    }
    return null;
  };
  for (let n = 0; n < d.turns.length; n++) {
    const tool = walk(d.turns[n].items);
    if (tool) return { tool, turn: d.turns[n], n: n + 1 };
  }
  return null;
}

export const findTurn = (d: SessionDetail, promptId: string) => {
  const n = d.turns.findIndex((t) => t.promptId === promptId);
  return n < 0 ? null : { turn: d.turns[n], n: n + 1 };
};

const cut = (s: string | null | undefined, n: number) => (!s ? '' : s.length > n ? `${s.slice(0, n)}…` : s);

/** What the user is looking at, in words, sent with each chat message. */
export function describeView(d: SessionDetail | null, v: View): string {
  if (!d || !v.id) return 'The session list; no session is open.';
  const tab = TABS.find((t) => t.id === v.tab)?.label ?? v.tab;
  const lines = [`Session "${titleOf(d.session)}" (${d.session.id}), ${tab} tab.`];
  const s = v.sel;
  if (!s) lines.push('Nothing is selected.');
  else if (s.kind === 'turn') {
    const hit = findTurn(d, s.key);
    if (hit) {
      const t = hit.turn;
      lines.push(`Selected: turn #${hit.n} at ${t.ts} (${formatMs(t.durationMs)}, ${formatUsd(t.costUsd)}, ${t.toolCalls} tool calls).`);
      lines.push(`Prompt (${t.promptKind}): ${cut(t.prompt, 3000)}`);
      for (const i of t.items) {
        if (i.kind === 'response') lines.push(`Claude: ${cut(i.text, 1500)}`);
        else if (i.kind === 'tool') lines.push(`Tool ${i.name}: ${cut(i.label, 200)} (${formatMs(i.durationMs)}${i.success ? '' : ', failed'})`);
        else if (i.kind === 'subagent') lines.push(`Subagent ${i.agentType ?? ''}: ${i.items.length} steps, ${formatMs(i.durationMs)}`);
        else if (i.kind === 'error') lines.push(`API error: ${i.text}`);
      }
    }
  } else if (s.kind === 'tool') {
    const hit = findTool(d, s.key);
    if (hit) {
      lines.push(`Selected: a ${hit.tool.name} call in turn #${hit.n} at ${hit.tool.ts}, ${formatMs(hit.tool.durationMs)}${hit.tool.success ? '' : ', failed'} (tool_use_id ${s.key}; its output is in spans.output).`);
      lines.push(`Input: ${cut(hit.tool.input, 4000)}`);
    }
  } else if (s.kind === 'child') {
    const c = d.children.find((x) => x.id === s.key);
    if (c) lines.push(`Selected: launched session ${c.id} "${titleOf(c)}" in ${c.folder ?? '?'}, ${formatUsd(c.costUsd)}, ${formatTokens(c.tokens)} tokens.${c.summary ? ` Recap: ${c.summary}` : ''}`);
  }
  return lines.join('\n');
}
