import { useEffect, useState } from 'react';
import { ChatPane } from './components/ChatPane';
import { href, parseRoute, useLab } from './store';
import { Repo } from './views/Repo';
import { Session } from './views/Session';
import { Sessions } from './views/Sessions';
import { Suggestion } from './views/Suggestion';

/** Which chat a page gets: one per page (sessions list, repo, each session, each suggestion). */
function chatTarget(route: ReturnType<typeof parseRoute>): { chatKey: string; label: string } {
  if (route.page === 'repo') return { chatKey: 'repo', label: 'the repo' };
  if (route.page === 'session') return { chatKey: route.id, label: route.id };
  if (route.page === 'suggestion') return { chatKey: route.sid, label: route.sid };
  return { chatKey: 'sessions', label: 'the sessions' };
}

export function App() {
  const lab = useLab();
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseRoute(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const suite = lab.tasks.filter((t) => t.approved && !t.heldOut).length;
  return (
    <>
      <header className="top">
        <a className="brand" href={href.sessions()}>
          frugal
        </a>
        <span className="sep" />
        {lab.repo ? (
          <a className={'repo' + (route.page === 'repo' ? ' current' : '')} href={href.repo()} title="Setup, skill activation and task suite">
            <span className="dim">Repo</span> <span className="strong">{lab.repo.name}</span> <span className="mono dim">@ {lab.repo.commit.slice(0, 7)}</span>{' '}
            {lab.profile ? <span className="ready">● ready</span> : <span className="pending">● setup pending</span>}
          </a>
        ) : (
          <span className="dim">{lab.loaded ? 'No repo registered' : 'Loading…'}</span>
        )}
        {lab.repo && (
          <>
            <span className="sep" />
            <span className="dim small">
              {lab.profile ? `profile v${lab.profile.version} · ` : ''}
              {suite} {suite === 1 ? 'task' : 'tasks'}
            </span>
          </>
        )}
        <span className="spacer" />
        {lab.error && (
          <span className="errflag" title={lab.error}>
            API unreachable
          </span>
        )}
      </header>
      {!lab.loaded ? (
        <main className="page">
          <p className="empty">Loading…</p>
        </main>
      ) : !lab.repo ? (
        <main className="page">
          <p className="empty">
            No data yet. Start a session with <code>npm run lab -- session</code>.{lab.error ? ` (${lab.error})` : ''}
          </p>
        </main>
      ) : (
        <>
          {route.page === 'sessions' && <Sessions />}
          {route.page === 'repo' && <Repo />}
          {route.page === 'session' && <Session id={route.id} />}
          {route.page === 'suggestion' && <Suggestion id={route.id} sid={route.sid} />}
          <ChatPane {...chatTarget(route)} />
        </>
      )}
    </>
  );
}
