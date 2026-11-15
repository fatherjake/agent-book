import { useEffect, useState } from 'react';
import { useHashPath } from './api';
import { HomeView } from './views/Home';
import { ExperimentView } from './views/Experiment';
import { RunView } from './views/Run';

type Theme = 'auto' | 'light' | 'dark';

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('frugal-theme');
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* storage unavailable */
  }
  return 'auto';
}

export function App() {
  const path = useHashPath();
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('frugal-theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const seg = path.split('/').filter(Boolean);
  let view;
  if (seg[0] === 'experiments' && seg[1]) view = <ExperimentView id={seg.slice(1).join('/')} />;
  else if (seg[0] === 'runs' && seg[1]) view = <RunView id={seg.slice(1).join('/')} />;
  else view = <HomeView />; // '#/', and the old '#/experiments' and '#/charts' links

  const nextTheme: Record<Theme, Theme> = { auto: 'light', light: 'dark', dark: 'auto' };
  return (
    <>
      <header className="ds-header">
        <div className="ds-header__inner">
          <div className="ds-header__left">
            <a className="ds-brand" href="#/">
              Frugal
            </a>
            <nav className="ds-nav">
              <a href="#/" aria-current={seg.length === 0 || seg[0] === 'experiments' || seg[0] === 'charts' || seg[0] === 'runs' ? 'page' : undefined}>
                Experiments
              </a>
            </nav>
          </div>
          <div className="ds-header__meta">
            <span className="ds-truncate">token benchmark · read-only</span>
            <button className="ds-link--quiet" type="button" onClick={() => setTheme(nextTheme[theme])} title="Toggle theme">
              Theme: {theme}
            </button>
          </div>
        </div>
      </header>
      <main className="ds-main">{view}</main>
      <footer className="ds-footer ds-caption">Read-only view of results/. Refresh to update.</footer>
    </>
  );
}
