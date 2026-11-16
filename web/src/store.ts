import { useSyncExternalStore } from 'react';
import type { Repo, RepoProfile, Session, SuggestionStatus, Task } from './types';

/** The repo this UI shows (one repo for now). */
export const REPO_ID = 'tiny';
const POLL_MS = 4000;

export interface LabState {
  loaded: boolean;
  error: string | null;
  repo: Repo | null;
  profile: RepoProfile | null;
  tasks: Task[];
  sessions: Session[];
}

let state: LabState = { loaded: false, error: null, repo: null, profile: null, tasks: [], sessions: [] };
const listeners = new Set<() => void>();
const set = (patch: Partial<LabState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}

export async function refresh(): Promise<void> {
  try {
    const [repo, sessions] = await Promise.all([
      getJson<{ repo: Repo; profile: RepoProfile | null; tasks: Task[] }>(`/api/repos/${REPO_ID}`),
      getJson<Session[]>(`/api/repos/${REPO_ID}/sessions`),
    ]);
    set({ loaded: true, error: null, repo: repo.repo, profile: repo.profile, tasks: repo.tasks, sessions });
  } catch (e) {
    set({ loaded: true, error: String((e as Error).message ?? e) });
  }
}

let timer: number | undefined;
function ensurePolling() {
  if (timer !== undefined) return;
  void refresh();
  timer = window.setInterval(() => void refresh(), POLL_MS);
}

export function useLab(): LabState {
  ensurePolling();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

async function post(url: string, body: unknown): Promise<void> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${url}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  await refresh();
}

export function decide(suggestionId: string, status: Extract<SuggestionStatus, 'accepted' | 'rejected' | 'tested'>): Promise<void> {
  return post(`/api/suggestions/${encodeURIComponent(suggestionId)}/decision`, { status }).catch((e) => alert(String(e.message ?? e)));
}

export function approveTask(taskId: string, approved: boolean): Promise<void> {
  return post(`/api/tasks/${encodeURIComponent(taskId)}/approval`, { approved }).catch((e) => alert(String(e.message ?? e)));
}

/** Hash routes: #/  ·  #/repo  ·  #/sessions/:id  ·  #/sessions/:id/suggestions/:sid */
export type Route = { page: 'sessions' } | { page: 'repo' } | { page: 'session'; id: string } | { page: 'suggestion'; id: string; sid: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'sessions' && parts[1] && parts[2] === 'suggestions' && parts[3]) return { page: 'suggestion', id: parts[1], sid: parts[3] };
  if (parts[0] === 'sessions' && parts[1]) return { page: 'session', id: parts[1] };
  if (parts[0] === 'repo') return { page: 'repo' };
  return { page: 'sessions' };
}

export const href = {
  sessions: () => '#/',
  repo: () => '#/repo',
  session: (id: string) => `#/sessions/${encodeURIComponent(id)}`,
  suggestion: (id: string, sid: string) => `#/sessions/${encodeURIComponent(id)}/suggestions/${encodeURIComponent(sid)}`,
};
