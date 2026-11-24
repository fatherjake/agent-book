/**
 * The suggestions lab's HTTP API (mounted at /api/lab by the web server):
 *
 *   GET  /?session=<id>                 the session's lab state (analysis, brief, suggestions, runs)
 *   POST /analyse?session=<id>          start an analysis (replaces the previous one)
 *   POST /brief?session=<id>            {task, checks, budgetUsd}: edit the brief (a new version)
 *   POST /run?session=<id>              {suggestion, runs}: have `runs` baseline and candidate runs
 *   POST /stop?session=<id>             {suggestion?}: stop the analysis, or a suggestion's runs
 *   POST /decide?session=<id>           {suggestion, decision: accepted | rejected | null}
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { markBusy, markIdle } from '../activity.js';
import { json, readBody } from '../claude.js';
import { TelemetryDb } from '../store.js';
import { startAnalysis } from './analyse.js';
import { requestRuns, settleOrphans, stopRuns } from './evaluate.js';
import type { HeadlessRun } from './headless.js';
import { loadLab, updateLab } from './state.js';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createLab() {
  const analyses = new Map<string, HeadlessRun>();

  return async function handler(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const id = url.searchParams.get('session') ?? '';
    try {
      if (!SESSION_ID.test(id)) return json(res, 400, { error: 'Bad session id' });

      if (req.method === 'GET' && url.pathname === '/') {
        const s = loadLab(id);
        // An analysis or run marked as going that nothing here is doing: the server restarted mid-way.
        if (s.analysis?.status === 'running' && !analyses.has(id))
          updateLab(id, (st) => st.analysis && Object.assign(st.analysis, { status: 'failed', error: 'The server restarted while this was running.', finishedAt: new Date().toISOString() }));
        settleOrphans(id);
        return json(res, 200, loadLab(id));
      }
      if (req.method !== 'POST') return json(res, 404, { error: 'Not found' });
      const body = await readBody(req);

      if (url.pathname === '/analyse') {
        if (analyses.has(id)) return json(res, 409, { error: 'An analysis is already running.' });
        const db = TelemetryDb.openReadonly();
        if (!db) return json(res, 503, { error: 'Nothing has been collected yet.' });
        try {
          analyses.set(
            id,
            startAnalysis(db, id, () => {
              analyses.delete(id);
              markIdle(`analysis:${id}`);
            }),
          );
          markBusy(`analysis:${id}`);
        } finally {
          db.close();
        }
        return json(res, 202, loadLab(id));
      }

      if (url.pathname === '/brief') {
        const task = typeof body.task === 'string' ? body.task.trim() : '';
        const checks = Array.isArray(body.checks) ? body.checks.map((c) => String(c).trim()).filter(Boolean) : [];
        const budget = Number(body.budgetUsd);
        if (!task || !checks.length) return json(res, 400, { error: 'The brief needs a task and at least one check.' });
        if (!(budget > 0 && budget <= 200)) return json(res, 400, { error: 'The budget per run must be between $0 and $200.' });
        const s = updateLab(id, (st) => {
          if (!st.brief) return;
          const same = st.brief.task === task && st.brief.checks.join('\n') === checks.join('\n');
          // Changing the task or checks starts a new version (old runs aren't compared any more); the budget alone doesn't.
          st.brief = { version: st.brief.version + (same ? 0 : 1), task, checks, budgetUsd: budget, edited: st.brief.edited || !same };
        });
        return json(res, 200, s);
      }

      if (url.pathname === '/run') {
        const runs = Math.round(Number(body.runs));
        if (!(runs >= 1 && runs <= 5)) return json(res, 400, { error: 'Runs must be 1 to 5.' });
        requestRuns(id, String(body.suggestion ?? ''), runs);
        return json(res, 202, loadLab(id));
      }

      if (url.pathname === '/decide') {
        const decision = body.decision === 'accepted' || body.decision === 'rejected' ? body.decision : null;
        let found = false;
        const s = updateLab(id, (st) => {
          const x = st.suggestions.find((y) => y.id === body.suggestion);
          if (!x) return;
          found = true;
          if (decision) Object.assign(x, { decision, decidedAt: new Date().toISOString() });
          else {
            delete x.decision;
            delete x.decidedAt;
          }
        });
        return found ? json(res, 200, s) : json(res, 404, { error: 'No such suggestion.' });
      }

      if (url.pathname === '/stop') {
        if (typeof body.suggestion === 'string') stopRuns(id, body.suggestion);
        else analyses.get(id)?.proc.kill('SIGINT');
        return json(res, 200, loadLab(id));
      }
      json(res, 404, { error: 'Not found' });
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : 'Lab request failed' });
    }
  };
}
