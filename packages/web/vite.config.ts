import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vite';
import { createChat } from '../server/src/chat.js';
import { sessionDetail, toolOutput } from '../server/src/session-detail.js';
import { listSessions } from '../server/src/sessions.js';
import { TelemetryDb } from '../server/src/store.js';

/**
 * Read-only API over the telemetry store, served by Vite itself (dev and preview):
 *
 *   GET /api/sessions               every session (list page)
 *   GET /api/sessions/:id           one session in detail (session page)
 *   GET /api/tool-output/:toolUseId a tool call's output
 *   /api/chat                        the page chat (packages/server/src/chat.ts)
 */
function api(): Plugin {
  const handle = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = req.url?.split('?')[0] ?? '';
    if (req.method !== 'GET' || !path.startsWith('/api/') || path.startsWith('/api/chat')) return next();
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const db = TelemetryDb.openReadonly();
    if (!db) return path === '/api/sessions' ? send(200, { sessions: [] }) : send(404, { error: 'nothing collected yet' });
    try {
      const detail = path.match(/^\/api\/sessions\/([0-9a-f-]{36})$/);
      const output = path.match(/^\/api\/tool-output\/([A-Za-z0-9_-]{1,100})$/);
      if (path === '/api/sessions') send(200, { sessions: listSessions(db) });
      else if (detail) {
        const d = sessionDetail(db, detail[1]);
        if (d) send(200, d);
        else send(404, { error: 'no such session' });
      } else if (output) send(200, { output: toolOutput(db, output[1]) });
      else send(404, { error: 'not found' });
    } catch (e) {
      send(500, { error: String((e as Error)?.message ?? e) });
    } finally {
      db.close();
    }
  };
  // The chat runs `claude -p` from the repository root.
  const chat = createChat(fileURLToPath(new URL('../..', import.meta.url)));
  return {
    name: 'agent-book-api',
    configureServer: (s) => {
      s.middlewares.use('/api/chat', chat);
      s.middlewares.use(handle);
    },
    configurePreviewServer: (s) => {
      s.middlewares.use('/api/chat', chat);
      s.middlewares.use(handle);
    },
  };
}

export default defineConfig({
  plugins: [react(), api()],
  server: { port: 5180, host: '127.0.0.1' },
  preview: { port: 5180, host: '127.0.0.1' },
});
