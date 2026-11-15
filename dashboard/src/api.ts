import { useEffect, useState } from 'react';

export interface Loadable<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

export function useApi<T>(path: string): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ data: null, error: null, loading: true });
  useEffect(() => {
    let cancelled = false;
    setState({ data: null, error: null, loading: true });
    fetch(path, { headers: { accept: 'application/json' } })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        return body as T;
      })
      .then((data) => !cancelled && setState({ data, error: null, loading: false }))
      .catch((err: Error) => !cancelled && setState({ data: null, error: err.message, loading: false }));
    return () => {
      cancelled = true;
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
