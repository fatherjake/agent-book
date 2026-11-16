import { useSyncExternalStore } from 'react';
import { SESSIONS } from './mock';
import type { Session, SuggestionStatus } from './types';

/** In-memory store over the mock data. Accept/reject only change this page's state. */
let sessions: Session[] = SESSIONS;
const listeners = new Set<() => void>();

export function useSessions(): Session[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => sessions,
  );
}

export function decide(sessionId: string, suggestionId: string, status: Extract<SuggestionStatus, 'accepted' | 'rejected' | 'tested'>): void {
  sessions = sessions.map((s) =>
    s.id !== sessionId ? s : { ...s, suggestions: s.suggestions.map((g) => (g.id === suggestionId ? { ...g, status } : g)) },
  );
  for (const l of listeners) l();
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
