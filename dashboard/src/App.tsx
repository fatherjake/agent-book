import { useEffect, useState } from 'react';
import { useHashPath } from './api';
import { OverviewView } from './views/Overview';
import { HistoryView } from './views/History';
import { ChartsView } from './views/ChartsView';
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
  let active = 'overview';
  if (seg[0] === 'experiments' && seg[1]) {
    view = <ExperimentView id={seg.slice(1).join('/')} />;
    active = 'experiments';
  } else if (seg[0] === 'experiments') {
    view = <HistoryView />;
    active = 'experiments';
  } else if (seg[0] === 'runs' && seg[1]) {
    view = <RunView id={seg.slice(1).join('/')} />;
    active = 'experiments';
  } else if (seg[0] === 'charts') {
    view = <ChartsView />;
    active = 'charts';
  } else {
    view = <OverviewView />;
  }

  const nextTheme: Record<Theme, Theme> = { auto: 'light', light: 'dark', dark: 'auto' };
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/">
          Frugal <span className="muted">token benchmark</span>
        </a>
        <nav>
          <a className={active === 'overview' ? 'active' : ''} href="#/">Overview</a>
          <a className={active === 'experiments' ? 'active' : ''} href="#/experiments">Experiments</a>
          <a className={active === 'charts' ? 'active' : ''} href="#/charts">Charts</a>
        </nav>
        <button className="theme-btn" onClick={() => setTheme(nextTheme[theme])} title="Toggle theme">
          Theme: {theme}
        </button>
      </header>
      <main>{view}</main>
      <footer className="muted small">Read-only view of results/. Refresh to update.</footer>
    </div>
  );
}
