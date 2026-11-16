/**
 * npm run lab -- <command>
 *
 *   session [--repo tiny] [--runs-per-task 3] [--concurrency 3] [--test-top 3]
 *                                       run the current skills on the task suite, analyse, test the top suggestions
 *   resume  --session <id>              continue a session from its next unfinished phase (runs, analysis, testing)
 *   setup   [--repo tiny] [--probes 3]  set up and evaluate the repo (profile for the repo page; probes cost tokens)
 *   regrade                             re-score the visual design criterion of finished runs from their saved screenshots
 *   serve   [--port 5181]                                          API + web UI (build it first: npm --prefix web run build)
 *   status  [--repo tiny]                                          sessions and their runs, as text
 */
import { parseArgs } from 'node:util';
import { LabDb } from './db.js';
import { createSession, registerRepo, runSession, sessionSkillDiffs } from './session.js';
import { overlayPatch } from './skills.js';
import { startServer } from './server.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string', default: 'tiny' },
    'runs-per-task': { type: 'string', default: '3' },
    concurrency: { type: 'string', default: '3' },
    port: { type: 'string', default: '5181' },
    'test-top': { type: 'string', default: '3' },
    session: { type: 'string' },
    probes: { type: 'string', default: '3' },
  },
});
const cmd = positionals[0];

async function main() {
  if (cmd === 'serve') {
    const port = Number(values.port);
    startServer({ port });
    console.log(`lab: http://127.0.0.1:${port}/`);
    return;
  }
  const db = new LabDb();
  if (cmd === 'session') {
    db.failStaleRuns('the lab process stopped before the run finished');
    const opts = { runsPerTask: Number(values['runs-per-task']), concurrency: Number(values.concurrency), testTop: Number(values['test-top']) };
    const { session, overlay, repo } = createSession(db, values.repo!, opts);
    console.log(`lab: ${session.id} started (${db.sessionRuns(session.id).length} runs, skills: ${session.skillsVersion})`);
    const ac = new AbortController();
    process.once('SIGINT', () => ac.abort());
    await runSession(db, session.id, overlay, repo, { ...opts, signal: ac.signal });
    const runs = db.sessionRuns(session.id);
    console.log(`lab: ${session.id} finished: ${runs.filter((r) => r.status === 'done').length}/${runs.length} runs done, ${db.listSuggestions(session.id).length} suggestions`);
    return;
  }
  if (cmd === 'resume') {
    if (!values.session) throw new Error('--session <id> is required');
    db.failStaleRuns('the lab process stopped before the run finished');
    const s = db.getSession(values.session);
    if (!s) throw new Error(`unknown session ${values.session}`);
    const repo = registerRepo(db, s.repoId);
    const opts = { runsPerTask: 0, concurrency: Number(values.concurrency), testTop: Number(values['test-top']) };
    const overlay = overlayPatch(repo.skills, sessionSkillDiffs(db, s.id));
    const ac = new AbortController();
    process.once('SIGINT', () => ac.abort());
    await runSession(db, s.id, overlay, repo, { ...opts, signal: ac.signal });
    console.log(`lab: ${s.id} ${db.getSession(s.id)!.status}: ${db.listSuggestions(s.id).map((g) => `${g.id} ${g.status}`).join(', ')}`);
    return;
  }
  if (cmd === 'setup') {
    const { runSetup } = await import('./setup.js');
    const ac = new AbortController();
    process.once('SIGINT', () => ac.abort());
    const v = await runSetup(db, values.repo!, { probes: Number(values.probes), concurrency: Number(values.concurrency), signal: ac.signal });
    const p = db.latestProfile(values.repo!);
    console.log(`lab: profile v${v} saved`);
    for (const s of p.setup) console.log(`  ${s.status.padEnd(4)} ${s.label}: ${s.detail}`);
    return;
  }
  if (cmd === 'regrade') {
    const { regradeVisual } = await import('./regrade.js');
    for (const line of await regradeVisual(db)) console.log(line);
    return;
  }
  if (cmd === 'status') {
    registerRepo(db, values.repo!);
    for (const s of db.listSessions(values.repo)) {
      const runs = db.sessionRuns(s.id);
      console.log(`${s.id}  ${s.status.padEnd(9)} ${s.skillsVersion}  runs ${runs.filter((r) => r.status === 'done').length}/${runs.length}`);
      for (const r of runs) console.log(`  ${r.id}  ${r.taskId.padEnd(12)} ${r.status.padEnd(8)} ${String(r.criteriaMet.length).padStart(2)} met  ${r.tokens} tok  ${r.error ?? ''}`);
    }
    return;
  }
  console.error('usage: npm run lab -- setup|session|resume|regrade|serve|status [--repo tiny] [--runs-per-task N] [--concurrency N] [--port N]');
  process.exitCode = 2;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
