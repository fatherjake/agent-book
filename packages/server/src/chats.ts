/**
 * Where the page chats keep their state: ~/.agent-book/chats/<key>.json, one per session page (keyed by
 * the viewed session's id) plus "general" for no session. Each holds the chat's own Claude Code session
 * id and its messages.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CHATS_DIR = () => process.env.AGENT_BOOK_CHATS_DIR ?? join(homedir(), '.agent-book', 'chats');

export type ChatPart = { kind: 'text'; text: string } | { kind: 'tool'; label: string };
export interface ChatMessage {
  role: 'user' | 'assistant';
  parts: ChatPart[];
  /** What the user was looking at when they sent it (user messages). */
  view?: string;
}
export interface ChatState {
  /** The chat's own Claude Code session id. */
  sessionId: string;
  started: boolean;
  messages: ChatMessage[];
}

const file = (key: string) => join(CHATS_DIR(), `${key}.json`);

export function loadChat(key: string): ChatState | null {
  try {
    return JSON.parse(readFileSync(file(key), 'utf8')) as ChatState;
  } catch {
    return null;
  }
}

export function saveChat(key: string, state: ChatState): void {
  mkdirSync(CHATS_DIR(), { recursive: true });
  writeFileSync(file(key), JSON.stringify(state, null, 2));
}

/** The Claude Code session ids of every page chat: they're the dashboard talking, not work to list. */
export function chatSessionIds(): Set<string> {
  const out = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(CHATS_DIR());
  } catch {
    return out;
  }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const s = loadChat(n.slice(0, -5));
    if (s?.sessionId) out.add(s.sessionId);
  }
  return out;
}
