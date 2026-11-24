import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vite';
import { isWorking } from '../server/src/activity.js';
import { createChat } from '../server/src/chat.js';
import { createLab } from '../server/src/lab/api.js';
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
 *   /api/lab                         suggestions: analysis and evaluations (packages/server/src/lab/)
 */
function api(): Plugin {
  const handle = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = req.url?.split('?')[0] ?? '';
    if (req.method !== 'GET' || !path.startsWith('/api/') || path.startsWith('/api/chat') || path.startsWith('/api/lab')) return next();
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
  const lab = createLab();
  return {
    name: 'agent-book-api',
    configureServer: (s) => {
      s.middlewares.use('/api/chat', chat);
      s.middlewares.use('/api/lab', lab);
      s.middlewares.use(handle);
    },
    configurePreviewServer: (s) => {
      s.middlewares.use('/api/chat', chat);
      s.middlewares.use('/api/lab', lab);
      s.middlewares.use(handle);
    },
  };
}

/**
 * Set by scripts/launch-mac.sh (the Dock app): quit once no page has been connected for a while, so
 * closing the window stops the server, as in CV Hub. It never quits while lab runs or chat replies are
 * going: it checks again later. The grace periods cover page reloads and the first load.
 */
function exitWhenClosed(): Plugin {
  return {
    name: 'exit-when-closed',
    apply: 'serve',
    configureServer(server) {
      if (process.env.AGENT_BOOK_EXIT_WHEN_CLOSED !== '1') return;
      let clients = 0;
      let timer: NodeJS.Timeout | undefined;
      const schedule = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          if (clients > 0) return;
          if (isWorking()) return schedule(30_000);
          server.config.logger.info('No window open, stopping.');
          await server.close();
          process.exit(0);
        }, ms);
      };
      server.ws.on('vite:client:connect', () => {
        clients++;
        clearTimeout(timer);
      });
      server.ws.on('vite:client:disconnect', () => {
        clients = Math.max(0, clients - 1);
        if (clients === 0) schedule(10_000);
      });
      schedule(60_000);
    },
  };
}

export default defineConfig({
  plugins: [react(), api(), exitWhenClosed()],
  // strictPort: the Dock app's launcher looks for the server on this port.
  server: { port: 5180, host: '127.0.0.1', strictPort: true },
  preview: { port: 5180, host: '127.0.0.1', strictPort: true },
});
