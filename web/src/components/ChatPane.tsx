/**
 * Floating chat box on every page: one continuous Claude Code session per page (the sessions list, the
 * repo, a session, a suggestion), started with that page's context (lab/chat.ts). Drag it by its header,
 * resize it from the bottom-right corner; position, size and open state are remembered.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

interface ChatPart {
  kind: 'text' | 'tool';
  text?: string;
  label?: string;
}
interface ChatMessage {
  role: 'user' | 'assistant';
  parts: ChatPart[];
}
interface ChatInfo {
  enabled: boolean;
  sessionId: string;
  started: boolean;
  messages: ChatMessage[];
  busy: boolean;
  title: string;
}

const BOX_KEY = 'agent-book-chat-box';
const OPEN_KEY = 'agent-book-chat-open';
const DEFAULT_W = 550;
const DEFAULT_H = 400;
const MIN_W = 320;
const MIN_H = 220;
const MARGIN = 16;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Keep the box fully inside the viewport (and no bigger than it). */
function clampBox(b: Box): Box {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.max(Math.min(MIN_W, vw - 2 * MARGIN), Math.min(b.w, vw - 2 * MARGIN));
  const h = Math.max(Math.min(MIN_H, vh - 2 * MARGIN), Math.min(b.h, vh - 2 * MARGIN));
  return { w, h, x: Math.min(Math.max(MARGIN, b.x), vw - w - MARGIN), y: Math.min(Math.max(MARGIN, b.y), vh - h - MARGIN) };
}

function readBox(): Box {
  try {
    const v = JSON.parse(localStorage.getItem(BOX_KEY) ?? 'null');
    if (v && [v.x, v.y, v.w, v.h].every((n) => typeof n === 'number' && Number.isFinite(n))) return clampBox(v);
  } catch {
    /* storage unavailable */
  }
  return clampBox({ w: DEFAULT_W, h: DEFAULT_H, x: window.innerWidth - DEFAULT_W - MARGIN, y: window.innerHeight - DEFAULT_H - MARGIN });
}
function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

const url = (key: string, action = '') => `/api/chat/${encodeURIComponent(key)}${action}`;

const HINTS: Record<string, string> = {
  sessions: 'Try: "How have the sessions changed over time?"',
  repo: 'Try: "Why does saiyan only fire when it is named?"',
};

export function ChatPane({ chatKey, label }: { chatKey: string; label: string }) {
  const [info, setInfo] = useState<ChatInfo | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(readOpen);
  const [box, setBox] = useState<Box>(readBox);
  const log = useRef<HTMLDivElement>(null);
  const boxRef = useRef(box);
  boxRef.current = box;

  // Stay inside the window when it shrinks.
  useLayoutEffect(() => {
    const onResize = () => setBox((b) => clampBox(b));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /** Reload the saved conversation. `keepError`: a failed send's error stays visible. */
  const refresh = useCallback(async (keepError = false) => {
    try {
      const res = await fetch(url(chatKey), { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      const next = body as ChatInfo;
      setInfo(next);
      setMessages(next.messages);
      setBusy(next.busy);
      if (!next.enabled) setError('Chat is disabled: the lab server is not bound to a loopback address.');
      else if (!keepError) setError(null);
      return next;
    } catch (e) {
      setError(`Chat unavailable: ${(e as Error).message}`);
      return null;
    }
  }, [chatKey]);

  useEffect(() => {
    setInfo(null);
    setMessages([]);
    setError(null);
    void refresh();
  }, [refresh]);

  // A reply that was already running when the page loaded: poll until it lands.
  useEffect(() => {
    if (!info?.busy) return;
    const t = window.setInterval(async () => {
      const next = await refresh();
      if (next && !next.busy) window.clearInterval(t);
    }, 2000);
    return () => window.clearInterval(t);
  }, [info?.busy, refresh]);

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  async function send() {
    const message = draft.trim();
    if (!message || busy) return;
    setDraft('');
    setError(null);
    setBusy(true);
    let failed = false;
    setMessages((m) => [...m, { role: 'user', parts: [{ kind: 'text', text: message }] }, { role: 'assistant', parts: [] }]);
    const update = (fn: (reply: ChatMessage) => ChatMessage) =>
      setMessages((m) => {
        const copy = m.slice();
        copy[copy.length - 1] = fn(copy[copy.length - 1]);
        return copy;
      });
    try {
      const res = await fetch(url(chatKey), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          nl = buf.indexOf('\n');
          let ev: { type: string; text?: string; label?: string; message?: string };
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.type === 'text' && ev.text) {
            const text = ev.text;
            update((r) => {
              const parts = r.parts.slice();
              const last = parts.at(-1);
              if (last?.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: (last.text ?? '') + text };
              else parts.push({ kind: 'text', text: text.replace(/^\n+/, '') });
              return { ...r, parts };
            });
          } else if (ev.type === 'tool' && ev.label) {
            const l = ev.label;
            update((r) => ({ ...r, parts: [...r.parts, { kind: 'tool', label: l }] }));
          } else if (ev.type === 'error') {
            failed = true;
            setError(ev.message ?? 'Claude failed');
          }
        }
      }
    } catch (e) {
      // The message was not sent: say why and give the text back, so nothing is lost.
      failed = true;
      setError(`Not sent: ${(e as Error).message}`);
      setDraft((d) => d || message);
    } finally {
      setBusy(false);
      void refresh(failed);
    }
  }

  async function stop() {
    await fetch(url(chatKey, '/stop'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
  }

  /** Drag (move the box) or resize (from the bottom-right corner) with the pointer. */
  function track(e: ReactPointerEvent<HTMLElement>, mode: 'move' | 'resize') {
    if (e.button !== 0) return;
    if (mode === 'move' && (e.target as HTMLElement).closest('button, a, .chat-session')) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const start = boxRef.current;
    const next = (ev: PointerEvent): Box =>
      mode === 'move'
        ? clampBox({ ...start, x: start.x + ev.clientX - sx, y: start.y + ev.clientY - sy })
        : clampBox({ ...start, w: Math.max(MIN_W, start.w + ev.clientX - sx), h: Math.max(MIN_H, start.h + ev.clientY - sy) });
    const move = (ev: PointerEvent) => setBox(next(ev));
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('chat-dragging');
      store(BOX_KEY, JSON.stringify(next(ev)));
    };
    document.body.classList.add('chat-dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const toggle = () =>
    setOpen((o) => {
      store(OPEN_KEY, o ? '0' : '1');
      return !o;
    });
  const disabled = info !== null && !info.enabled;

  if (!open)
    return (
      <button type="button" className="chat-launcher" onClick={toggle} aria-expanded={false}>
        Ask Claude about <span className="mono">{label}</span>
        {busy && <span className="dim"> · answering…</span>}
      </button>
    );

  return (
    <section className="chat-box" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} aria-label={`Chat about ${label}`}>
      <div className="chat-head" onPointerDown={(e) => track(e, 'move')} title="Drag to move">
        <span className="chat-title">
          Ask Claude about <span className="mono">{label}</span>
        </span>
        <button type="button" className="chat-close" onClick={toggle} aria-label="Minimise chat" title="Minimise">
          –
        </button>
      </div>
      {info && (
        <div className="chat-session mono" title="Continue this chat in a terminal">
          {info.started ? `claude --resume ${info.sessionId}` : 'new chat · starts with this page as context'}
        </div>
      )}
      {open && (
        <>
          <div className="chat-log" ref={log}>
            {messages.length === 0 && !error && (
              <p className="dim chat-hint">
                Claude gets this page's data (runs, criteria, suggestions, diffs) and can read the repo, the run artifacts and the lab DB, read-only.{' '}
                {HINTS[chatKey] ?? 'Try: "Why did the most expensive run use more tokens than the cheapest one?"'}
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`chat-msg chat-${m.role}`}>
                {m.parts.length === 0 && m.role === 'assistant' && busy && i === messages.length - 1 && <span className="dim">Thinking…</span>}
                {m.parts.map((p, j) =>
                  p.kind === 'text' ? (
                    <div key={j} className="chat-text">
                      {p.text}
                    </div>
                  ) : (
                    <div key={j} className="chat-tool mono">
                      {p.label}
                    </div>
                  ),
                )}
              </div>
            ))}
            {error && <div className="run-error">{error}</div>}
          </div>
          <form
            className="chat-input"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              value={draft}
              disabled={disabled}
              placeholder={disabled ? 'Chat disabled' : 'Message Claude… (Enter to send, Shift+Enter for a new line)'}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
            />
            {busy ? (
              <button type="button" className="btn" onClick={() => void stop()}>
                Stop
              </button>
            ) : (
              <button type="submit" className="btn btn-primary" disabled={disabled || !draft.trim()}>
                Send
              </button>
            )}
          </form>
        </>
      )}
      <div className="chat-grip" onPointerDown={(e) => track(e, 'resize')} title="Drag to resize" />
    </section>
  );
}
