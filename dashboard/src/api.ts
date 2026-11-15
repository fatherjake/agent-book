import { useEffect, useState } from 'react';

export interface Loadable<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** How often every view re-fetches its data in the background (results are append-only, so this is cheap). */
export const POLL_MS = 5000;

/**
 * Fetch `path` and keep it fresh: re-fetches every POLL_MS while the tab is visible (and at once when it
 * becomes visible again). Background refreshes keep the current data on screen, only re-render when the
 * response changed, and a failed refresh leaves the last good data in place.
 */
export function useApi<T>(path: string): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ data: null, error: null, loading: true });
  useEffect(() => {
    let cancelled = false;
    let lastText: string | null = null;
    let inflight = false;
    setState({ data: null, error: null, loading: true });
    const load = () => {
      if (inflight || cancelled) return;
      inflight = true;
      fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store' })
        .then(async (res) => {
          const text = await res.text();
          let body: unknown = null;
          try {
            body = JSON.parse(text);
          } catch {
            /* not JSON */
          }
          if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
          if (cancelled || text === lastText) return;
          lastText = text;
          setState({ data: body as T, error: null, loading: false });
        })
        .catch((err: Error) => {
          if (cancelled) return;
          // Keep showing the last good data if a background refresh fails.
          setState((s) => (s.data ? s : { data: null, error: err.message, loading: false }));
        })
        .finally(() => {
          inflight = false;
        });
    };
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [path]);
  return state;
}

/** Minimal hash router: returns the path after '#', e.g. '/experiments/exp-001'. */
export function useHashPath(): string {
  const read = () => decodeURI(window.location.hash.replace(/^#/, '')) || '/';
  const [path, setPath] = useState(read);
  useEffect(() => {
    const onChange = () => {
      setPath(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return path;
}

export const enc = encodeURIComponent;
