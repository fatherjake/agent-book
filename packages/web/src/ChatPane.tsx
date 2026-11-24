/**
 * The page chat (same design as CV Hub's chat pane): one continuous Claude Code session per session
 * page, which starts with the page's content as context. Every message carries what the user is looking
 * at right now (the tab and the selected row), so "this turn" or "why is this so expensive" just works.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useResizable } from './resize';
import type { ChatMessage, ChatPart } from '../../server/src/chats';
import { Markdown } from './parts';

interface ChatInfo {
  sessionId: string | null;
  messages: ChatMessage[];
  busy: boolean;
}

const chatUrl = (key: string, action = '') => `/api/chat${action}?session=${encodeURIComponent(key)}`;

const DEFAULT_HEIGHT = 240;
const COLLAPSED_KEY = 'agent-book:chat-collapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** `chatKey` is the open session's id, or "general" with none open. `view` describes the screen now. */
export function ChatPane({ chatKey, view }: { chatKey: string; view: () => string }) {
  const [info, setInfo] = useState<ChatInfo | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resize = useResizable('agent-book:chat-height', { axis: 'y', invert: true, min: 90, max: () => window.innerHeight - 220 });
  const height = resize.size ?? DEFAULT_HEIGHT;
  // Collapsed: only the header and the input show; sending a message opens it again.
  const [collapsed, setCollapsedState] = useState(readCollapsed);
  const setCollapsed = (c: boolean) => {
    setCollapsedState(c);
    try {
      window.localStorage.setItem(COLLAPSED_KEY, c ? '1' : '0');
    } catch {
      // storage unavailable
    }
  };
  const log = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(chatUrl(chatKey));
      if (!response.ok) throw new Error(await response.text());
      const next = (await response.json()) as ChatInfo;
      setInfo(next);
      setMessages(next.messages);
      setBusy(next.busy);
      setError(null);
      return next;
    } catch {
      setError('The chat needs the dev server (npm run web).');
      return null;
    }
  }, [chatKey]);

  useEffect(() => {
    setMessages([]);
    setInfo(null);
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  // A reply that was still running when the page loaded: wait for it to land.
  useEffect(() => {
    if (!busy || !info?.busy) return;
    const timer = window.setInterval(async () => {
      const next = await refresh();
      if (next && !next.busy) window.clearInterval(timer);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [busy, info?.busy, refresh]);

  useEffect(() => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages]);

  async function send() {
    const message = draft.trim();
    if (!message || busy) return;
    if (collapsed) setCollapsed(false);
    setDraft('');
    setError(null);
    setBusy(true);
    setMessages((current) => [...current, { role: 'user', parts: [{ kind: 'text', text: message }] }, { role: 'assistant', parts: [] }]);

    const update = (change: (parts: ChatPart[]) => ChatPart[]) =>
      setMessages((current) => {
        const next = current.slice();
        const last = next[next.length - 1];
        next[next.length - 1] = { ...last, parts: change(last.parts) };
        return next;
      });

    try {
      const response = await fetch(chatUrl(chatKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, view: view() }),
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? 'Chat failed');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === 'text') {
            update((parts) => {
              const last = parts[parts.length - 1];
              return last?.kind === 'text' ? [...parts.slice(0, -1), { kind: 'text', text: last.text + event.text }] : [...parts, { kind: 'text', text: event.text }];
            });
          } else if (event.type === 'tool') {
            update((parts) => [...parts, { kind: 'tool', label: event.label }]);
          } else if (event.type === 'error') {
            setError(event.message);
          }
        }
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Chat failed');
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  async function stop() {
    await fetch(chatUrl(chatKey, '/stop'), { method: 'POST' }).catch(() => undefined);
  }

  return (
    <section className={`chat panel${collapsed ? ' collapsed' : ''}`} style={collapsed ? undefined : { height }} aria-label="Chat with Claude about this page">
      {!collapsed && (
        <div
          className="divider divider-y divider-top"
          onPointerDown={(e) => resize.onPointerDown(e, () => height)}
          onDoubleClick={resize.reset}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize chat"
          title="Drag to resize, double-click to reset"
        />
      )}
      <div className="panel-head">
        <span>Chat</span>
        <button className="panel-button" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} title={collapsed ? 'Maximise' : 'Minimise'} aria-label={collapsed ? 'Maximise chat' : 'Minimise chat'}>
          {collapsed ? '□' : '_'}
        </button>
      </div>
      <div className="chat-log" ref={log} aria-live="polite" hidden={collapsed}>
        {messages.length === 0 && (
          <p className="dim">
            {chatKey === 'general'
              ? 'Ask about your sessions in general.'
              : 'Ask about this session. Claude starts with everything on this page, sees which tab and row you have selected with each message, and can query the telemetry store and transcript for more. It is read-only.'}
          </p>
        )}
        {messages.map((message, index) => (
          <div key={index} className={`chat-msg is-${message.role}`}>
            <span className="chat-who">{message.role === 'user' ? 'you' : 'claude'}</span>
            <div className="chat-body">
              {message.parts.map((part, partIndex) =>
                part.kind === 'text' ? (
                  message.role === 'assistant' ? (
                    <Markdown key={partIndex} text={part.text} />
                  ) : (
                    <p key={partIndex} className="chat-text">
                      {part.text}
                    </p>
                  )
                ) : (
                  <p key={partIndex} className="chat-tool">
                    › {part.label}
                  </p>
                ),
              )}
              {busy && index === messages.length - 1 && message.role === 'assistant' && <p className="chat-tool">working…</p>}
            </div>
          </div>
        ))}
        {error && <p className="down">{error}</p>}
      </div>
      <form
        className="chat-input"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="Ask about this page (Enter to send, Shift+Enter for a new line)"
          rows={2}
          aria-label="Message"
        />
        {busy ? (
          <button type="button" className="button" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="button" disabled={!draft.trim()}>
            Send
          </button>
        )}
      </form>
    </section>
  );
}
