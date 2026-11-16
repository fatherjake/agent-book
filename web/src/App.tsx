import { useEffect, useState } from 'react';
import { REPO, REPO_PROFILE } from './mock';
import { href, parseRoute } from './store';
import { Repo } from './views/Repo';
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
        <a className={'repo' + (route.page === 'repo' ? ' current' : '')} href={href.repo()} title="Setup, skill activation and task suite">
          <span className="dim">Repo</span> <span className="strong">{REPO.name}</span> <span className="mono dim">@ {REPO.commit}</span>{' '}
          <span className="ready">● ready</span>
        </a>
        <span className="sep" />
        <span className="dim small" title={REPO.skills.join('\n')}>
          profile v{REPO_PROFILE.version} · {REPO.tasks.filter((t) => !t.heldOut).length} tasks · skills: saiyan, verify-tiny
        </span>
        <span className="spacer" />
        <span className="mockflag">Mock data</span>
      </header>
      {route.page === 'sessions' && <Sessions />}
      {route.page === 'repo' && <Repo />}
      {route.page === 'session' && <Session id={route.id} />}
      {route.page === 'suggestion' && <Suggestion id={route.id} sid={route.sid} />}
    </>
  );
}
