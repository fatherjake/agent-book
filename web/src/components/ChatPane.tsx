/**
 * Chat pane docked to the bottom of every page: one continuous Claude Code session per page (the
 * sessions list, the repo, a session, a suggestion), started with that page's context (lab/chat.ts).
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

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

const HEIGHT_KEY = 'frugal-lab-chat-height';
const OPEN_KEY = 'frugal-lab-chat-open';
const MIN_HEIGHT = 140;
const HEADER_H = 37;

function readHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY));
    if (v >= MIN_HEIGHT) return v;
  } catch {
    /* storage unavailable */
  }
  return 300;
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
  const [height, setHeight] = useState(readHeight);
  const log = useRef<HTMLDivElement>(null);

  // Reserve room at the bottom of the page so the pane never covers content.
  useEffect(() => {
    document.documentElement.style.setProperty('--chat-pane-h', `${open ? height : HEADER_H}px`);
    return () => {
      document.documentElement.style.removeProperty('--chat-pane-h');
    };
  }, [open, height]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(url(chatKey), { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      const next = body as ChatInfo;
      setInfo(next);
      setMessages(next.messages);
      setBusy(next.busy);
      setError(next.enabled ? null : 'Chat is disabled: the lab server is not bound to a loopback address.');
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
          } else if (ev.type === 'error') setError(ev.message ?? 'Claude failed');
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  async function stop() {
    await fetch(url(chatKey, '/stop'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
  }

  function startResize(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const clamp = (y: number) => Math.max(MIN_HEIGHT, Math.min(window.innerHeight - 80, startH + (startY - y)));
    const move = (ev: PointerEvent) => setHeight(clamp(ev.clientY));
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      store(HEIGHT_KEY, String(clamp(ev.clientY)));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const toggle = () =>
    setOpen((o) => {
      store(OPEN_KEY, o ? '0' : '1');
      return !o;
    });
  const disabled = info !== null && !info.enabled;

  return (
    <section className="chat-pane" style={{ height: open ? height : HEADER_H }} aria-label={`Chat about ${label}`}>
      {open && <div className="chat-resize" onPointerDown={startResize} title="Drag to resize" />}
      <div className="chat-head">
        <button type="button" className="chat-title" onClick={toggle} aria-expanded={open}>
          {open ? '▾' : '▸'} Ask Claude about <span className="mono">{label}</span>
        </button>
        {info && (
          <span className="chat-session mono" title="Continue this chat in a terminal">
            {info.started ? `claude --resume ${info.sessionId}` : 'new chat · starts with this page as context'}
          </span>
        )}
      </div>
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
    </section>
  );
}
