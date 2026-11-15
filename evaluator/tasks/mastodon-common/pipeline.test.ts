/**
 * Pipeline tests with a fake container (no Docker): phase ordering, skip behaviour, rspec reruns
 * on load errors, scoring and the report.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Browser } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CmdResult } from '../../docker.js';
import { runMastodonEvaluation, type EvalContainer, type MastodonTaskDefinition } from './evaluate.js';
import { TASK_DEFINITION as BOOKMARKS } from '../mastodon-bookmarks/index.js';

interface FakeOpts {
  applyFails?: boolean;
  migrateFails?: boolean;
  /** Upstream files that fail to load (NameError) in a combined run. */
  loadErrorFiles?: string[];
  failingRegression?: string;
}

const ok = (stdout = ''): CmdResult => ({ code: 0, stdout, stderr: '', timedOut: false });

function fakeContainer(url: string, def: MastodonTaskDefinition, o: FakeOpts, log: string[]): EvalContainer {
  const files = new Map<string, string>();
  const exec = async (cmd: string): Promise<CmdResult> => {
    log.push(cmd);
    if (cmd.startsWith('git apply')) return o.applyFails ? { code: 1, stdout: '', stderr: 'error: patch failed: app/models/status.rb:54', timedOut: false } : ok();
    if (cmd === 'bin/rails db:migrate') return o.migrateFails ? { code: 1, stdout: '', stderr: 'PG::DuplicateTable', timedOut: false } : ok();
    if (cmd.includes('bundle exec rspec')) {
      const out = /--out (\S+)/.exec(cmd)![1];
      const specFiles = [...cmd.matchAll(/'(spec\/[^']+)'/g)].map((m) => m[1]);
      const broken = specFiles.filter((f) => o.loadErrorFiles?.includes(f));
      const examples = broken.length
        ? []
        : specFiles.flatMap((f) => {
            const up = def.expectedUpstream.filter((x) => x.file === f).map((x) => ({ file_path: `./${f}`, full_description: x.fullDescription, status: 'passed' }));
            const reg = def.regression.some((r) => r.file === f) ? [{ file_path: `./${f}`, full_description: `${f} existing`, status: f === o.failingRegression ? 'failed' : 'passed' }] : [];
            return [...up, ...reg];
          });
      files.set(out, JSON.stringify({ examples, summary: { errors_outside_of_examples_count: broken.length }, messages: broken.map((f) => `An error occurred while loading ./${f}.\nNameError: uninitialized constant Api::V1::BookmarksController`) }));
      return ok('...');
    }
    if (cmd.includes('bin/rails runner') && cmd.includes('seed.rb')) return ok(`boot noise\nFRUGAL_JSON:${JSON.stringify({ users: { alice: { id: '1' } }, tokens: {} })}\n`);
    return ok();
  };
  return {
    url,
    exec,
    execLogged: async (_l: string, cmd: string) => exec(cmd),
    spawnBackground: (_l: string, cmd: string) => {
      log.push(`bg: ${cmd}`);
      return { proc: null as never, exited: () => 0 };
    },
    writeFile: async (p: string, c: Buffer | string) => void files.set(p, String(c)),
    copyFileIn: async (_h: string, p: string) => void files.set(p, 'copied'),
    readFile: async (p: string) => files.get(p) ?? null,
    state: async () => ({ running: true, oomKilled: false }),
    stop: async () => undefined,
    logs: () => log.join('\n'),
  } as unknown as EvalContainer;
}

describe('runMastodonEvaluation (fake container)', () => {
  let server: http.Server;
  let url = '';
  let tmp = '';
  beforeEach(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/v1/instance') return res.end('{}');
      if (req.url === '/auth/sign_in') return res.end('<html><script src="/packs/application.js"></script></html>');
      if (req.url === '/packs/application.js') return res.end('//js');
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-mastodon-pipeline-'));
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const def = (): MastodonTaskDefinition => ({
    ...BOOKMARKS,
    apiChecks: [{ spec: { id: 'api.fake', category: 'backend', mandatory: true }, run: async (ctx) => void expect(ctx.seed.users.alice.id).toBe('1') }],
    uiChecks: [{ spec: { id: 'ui.fake', category: 'functional', mandatory: true }, run: async () => undefined }],
  });

  async function run(o: FakeOpts, patch = 'diff --git a/x b/x\n') {
    const log: string[] = [];
    const patchFile = path.join(tmp, 'workspace.patch');
    fs.writeFileSync(patchFile, patch);
    const d = def();
    const r = await runMastodonEvaluation(
      d,
      { runId: 'r1', patchFile, suite: 'dev', seed: 1, outDir: tmp },
      {
        resolve: async () => ({ image: 'img', sandbox: { cpus: 4, memory: '6g', pidsLimit: 4096 } }),
        launch: async () => fakeContainer(url, d, o, log),
        launchBrowser: async () => ({ close: async () => undefined }) as unknown as Browser,
      },
    );
    return { r, log };
  }

  it('passes when every phase succeeds; report written', async () => {
    const { r, log } = await run({});
    const failed = r.checks.filter((c) => c.outcome !== 'pass').map((c) => `${c.id}: ${c.message}`);
    expect(failed).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['startup.patch', 'startup.migrate', 'startup.app', 'api.fake', 'ui.fake', 'regression.models/status']));
    expect(r.checks.filter((c) => c.id.startsWith('upstream.')).length).toBe(BOOKMARKS.expectedUpstream.length);
    expect(log.some((l) => l.includes('/opt/frugal/task/app start') && l.includes('--skip-migrate'))).toBe(true);
    expect(log.filter((l) => l.includes('bundle exec rspec')).length).toBe(2); // upstream + regression
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'report.json'), 'utf8')).details.timingsSec.total).toBeGreaterThanOrEqual(0);
  });

  it('a patch that does not apply fails startup and every other check, without throwing', async () => {
    const { r, log } = await run({ applyFails: true });
    expect(r.passed).toBe(false);
    expect(r.evaluatorFailure).toBe(false);
    expect(r.checks.find((c) => c.id === 'startup.patch')?.outcome).toBe('fail');
    expect(r.checks.find((c) => c.id === 'startup.app')?.outcome).toBe('fail');
    expect(r.checks.filter((c) => c.id !== 'startup.patch' && c.id !== 'startup.app').every((c) => c.outcome === 'fail')).toBe(true);
    expect(log.some((l) => l.includes('db:migrate'))).toBe(false);
  });

  it('failed migrations stop the evaluation', async () => {
    const { r } = await run({ migrateFails: true });
    expect(r.checks.find((c) => c.id === 'startup.migrate')?.outcome).toBe('fail');
    expect(r.appStarted).toBe(false);
    expect(r.passed).toBe(false);
  });

  it('empty patch = bare checkpoint: no git apply', async () => {
    const { log, r } = await run({}, '');
    expect(log.some((l) => l.startsWith('git apply'))).toBe(false);
    expect(r.checks.find((c) => c.id === 'startup.patch')?.message).toMatch(/bare checkpoint/);
  });

  it('an upstream load error reruns upstream files one by one and keeps the others', async () => {
    const broken = 'spec/controllers/api/v1/bookmarks_controller_spec.rb';
    const { r, log } = await run({ loadErrorFiles: [broken] });
    expect(log.filter((l) => l.includes('bundle exec rspec')).length).toBe(4); // combined, 2 singles, regression
    const up = r.checks.filter((c) => c.id.startsWith('upstream.'));
    expect(up.filter((c) => c.id.startsWith('upstream.bookmarks_controller')).every((c) => c.outcome === 'fail')).toBe(true);
    expect(up.filter((c) => c.id.startsWith('upstream.statuses/')).every((c) => c.outcome === 'pass')).toBe(true);
    expect(up.find((c) => c.outcome === 'fail')?.message).toContain('uninitialized constant');
    expect(r.passed).toBe(false);
  });

  it('a failing regression example fails its file check only', async () => {
    const { r } = await run({ failingRegression: 'spec/models/status_spec.rb' });
    expect(r.checks.filter((c) => c.outcome !== 'pass').map((c) => c.id)).toEqual(['regression.models/status']);
  });
});
