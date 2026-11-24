/**
 * Light / dark theme. With no choice made the page follows the system (styles.css); the button sets
 * `data-theme` on <html> and remembers it. index.html applies a saved choice before the first paint.
 */
import { useEffect, useState } from 'react';

const KEY = 'agent-book:theme';
type Theme = 'light' | 'dark';

const systemTheme = (): Theme => (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

function current(): Theme {
  const set = document.documentElement.dataset.theme;
  return set === 'light' || set === 'dark' ? set : systemTheme();
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(current);
  // Follow the system while no choice has been made.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const on = () => setTheme(current());
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      className="panel-button theme-toggle"
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          window.localStorage.setItem(KEY, next);
        } catch {
          // storage unavailable: the choice lasts until reload
        }
        setTheme(next);
      }}
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}
