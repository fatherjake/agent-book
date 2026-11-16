import { useEffect, useState } from 'react';
import { REPO } from './mock';
import { href, parseRoute } from './store';
import { Session } from './views/Session';
import { Sessions } from './views/Sessions';
import { Suggestion } from './views/Suggestion';

export function App() {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseRoute(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return (
    <>
      <header className="top">
        <a className="brand" href={href.sessions()}>
          frugal
        </a>
        <span className="sep" />
        <span className="repo">
          <span className="dim">Repo</span>{' '}
          <a className="strong" href={REPO.url} target="_blank" rel="noreferrer">
            {REPO.name}
          </a>{' '}
          <span className="mono dim">@ {REPO.commit}</span>
        </span>
        <span className="sep" />
        <span className="dim small" title={REPO.skills.join('\n')}>
          {REPO.tasks.length} tasks · skills: saiyan, verify-tiny
        </span>
        <span className="spacer" />
        <span className="mockflag">Mock data</span>
      </header>
      {route.page === 'sessions' && <Sessions />}
      {route.page === 'session' && <Session id={route.id} />}
      {route.page === 'suggestion' && <Suggestion id={route.id} sid={route.sid} />}
    </>
  );
}
