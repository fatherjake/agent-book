/**
 * The terminal layout: sessions down the left; on the right, the open session's headline panel, a tabbed
 * panel beside a detail panel for the selected row, and the page chat along the bottom. What is open
 * lives in the URL hash (view.ts).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionDetail } from '../../server/src/session-detail';
import type { SessionSummary } from '../../server/src/sessions';
import { ChatPane } from './ChatPane';
import { useLab } from './lab';
import { useResizable } from './resize';
import { Detail, DetailNav, detailTitle } from './details';
import { SessionHeader } from './SessionHeader';
import { Sidebar } from './Sidebar';
import { TabBody, tabCount } from './tabs';
import { describeView, parseHash, TABS, toHash, type Selection, type Tab, type View } from './view';

const LIST_REFRESH_MS = 15_000;
const DETAIL_REFRESH_MS = 30_000;

/** A draggable divider on a panel's edge; double-click restores the default size. */
function Divider({ axis, edge, onPointerDown, onDoubleClick }: { axis: 'x' | 'y'; edge: 'left' | 'right' | 'top' | 'bottom'; onPointerDown: (e: React.PointerEvent<HTMLElement>) => void; onDoubleClick: () => void }) {
  return (
    <div
      className={`divider divider-${axis} divider-${edge}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      title="Drag to resize, double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
    />
  );
}

const SIDEBAR_DEFAULT = 300;

type DetailLoad = { state: 'idle' } | { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; d: SessionDetail };

export function App() {
  const [view, setView] = useState<View>(() => parseHash(location.hash));
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailLoad>({ state: 'idle' });
  const lab = useLab(view.id);
  const side = useResizable('agent-book:sidebar-width', { axis: 'x', min: 180, max: () => window.innerWidth * 0.5 });
  const det = useResizable('agent-book:detail-width', { axis: 'x', invert: true, min: 240, max: () => window.innerWidth - (side.size ?? SIDEBAR_DEFAULT) - 320 });
  const detailRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const on = () => setView(parseHash(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  // The session list, kept fresh.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/sessions');
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        if (alive) {
          setSessions(body.sessions);
          setListError(null);
        }
      } catch (e) {
        if (alive) setListError(String((e as Error)?.message ?? e));
      }
    };
    void load();
    const t = setInterval(load, LIST_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // With no session open, open the most recent one.
  useEffect(() => {
    if (view.id || !sessions?.length) return;
    const latest = [...sessions].filter((s) => !s.parentId).sort((a, b) => (b.end ?? '').localeCompare(a.end ?? ''))[0];
    if (latest) location.replace(toHash({ id: latest.id, tab: 'convo', sel: null }));
  }, [view.id, sessions]);

  // The open session, refreshed in the background.
  useEffect(() => {
    if (!view.id) return setDetail({ state: 'idle' });
    let alive = true;
    setDetail({ state: 'loading' });
    const load = async (first: boolean) => {
      try {
        const res = await fetch(`/api/sessions/${view.id}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        if (alive) setDetail({ state: 'ok', d: body });
      } catch (e) {
        if (alive && first) setDetail({ state: 'error', message: String((e as Error)?.message ?? e) });
      }
    };
    void load(true);
    const t = setInterval(() => load(false), DETAIL_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [view.id]);

  const go = useCallback((next: View) => {
    const hash = toHash(next);
    if (hash !== location.hash) location.hash = hash;
  }, []);
  const select = useCallback((kind: Selection['kind'], key: string) => go({ ...view, sel: { kind, key } }), [go, view]);
  const setTab = useCallback((tab: Tab) => go({ ...view, tab }), [go, view]);

  // Number keys switch tabs (not while typing).
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= TABS.length) setTab(TABS[n - 1].id);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [setTab, go, view]);

  const d = detail.state === 'ok' && detail.d.session.id === view.id ? detail.d : null;
  // Read when a message is sent, so it describes the screen at that moment.
  // With nothing chosen, the first row is selected, so the detail panel always shows something: the first
  // suggestion on the Suggestions tab, the first turn elsewhere.
  const firstSuggestion = lab.state?.suggestions[0]?.id;
  const sel: Selection | null =
    view.sel ??
    (view.tab === 'suggestions' ? (firstSuggestion ? { kind: 'suggestion', key: firstSuggestion } : null) : d?.turns[0] ? { kind: 'turn', key: d.turns[0].promptId } : null);
  const shown: View = { ...view, sel };
  const viewRef = useRef({ d, view: shown, lab: lab.state });
  viewRef.current = { d, view: shown, lab: lab.state };
  const describe = useCallback(() => describeView(viewRef.current.d, viewRef.current.view, viewRef.current.lab), []);

  return (
    <div className="app" style={{ gridTemplateColumns: `${side.size ?? SIDEBAR_DEFAULT}px minmax(0, 1fr)` }}>
      <div className="side-wrap">
        <Sidebar sessions={sessions} error={listError} selected={view.id} tab={view.tab} />
        <Divider axis="x" edge="right" onPointerDown={(e) => side.onPointerDown(e, () => SIDEBAR_DEFAULT)} onDoubleClick={side.reset} />
      </div>
      <main className="content">
        {d ? (
          <>
            <SessionHeader d={d} />
            <div className="middle" style={det.size ? { gridTemplateColumns: `minmax(0, 1fr) ${det.size}px` } : undefined}>
              <section className="panel tabs-panel">
                <div className="tabbar" role="tablist">
                  {TABS.map((t, i) => {
                    const count = tabCount(d, t.id);
                    return (
                      <button key={t.id} role="tab" aria-selected={view.tab === t.id} className={view.tab === t.id ? 'active' : undefined} onClick={() => setTab(t.id)} title={`${t.label} (${i + 1})`}>
                        {t.label}
                        {count != null && <span className="num dim"> {count}</span>}
                      </button>
                    );
                  })}
                </div>
                <div className="scroll" role="tabpanel">
                  <TabBody tab={view.tab} d={d} sel={sel} select={select} lab={lab} />
                </div>
              </section>
              <section className="panel detail-panel" ref={detailRef}>
                <Divider axis="x" edge="left" onPointerDown={(e) => det.onPointerDown(e, () => detailRef.current?.offsetWidth ?? 400)} onDoubleClick={det.reset} />
                <div className="panel-head">
                  <span>{detailTitle(d, sel)}</span>
                  <DetailNav d={d} sel={sel} select={select} />
                </div>
                <div className="scroll">
                  <Detail d={d} sel={sel} select={select} lab={lab} />
                </div>
              </section>
            </div>
          </>
        ) : (
          <div className="panel placeholder">
            {detail.state === 'error' ? <p className="down">Couldn't load this session: {detail.message}</p> : <p className="dim">{view.id ? 'Loading session…' : 'Select a session.'}</p>}
          </div>
        )}
        <ChatPane chatKey={view.id ?? 'general'} view={describe} />
      </main>
    </div>
  );
}
