import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDevDb } from '../../dashboard/dev-seed.js';
import { createDashboardData, openReadOnlyDb, type DashboardData } from '../../dashboard/server/data.js';
import { createDashboardServer, resolveSafe } from '../../dashboard/server/http.js';
import type { Charts, ExperimentDetail, ExperimentRow, Overview, RunDetail } from '../../dashboard/src/api-types.js';

let tmp: string;
let resultsDir: string;
let dbPath: string;
let data: DashboardData;
let server: http.Server;
let port: number;

/** Raw request so paths like /artifacts/../x are sent verbatim (fetch would normalize them). */
function request(method: string, rawPath: string, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const headers = body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {};
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getJson<T>(p: string): Promise<T> {
  const res = await request('GET', p);
  expect(res.status, `${p} → ${res.body.toString()}`).toBe(200);
  expect(res.headers['content-type']).toMatch(/application\/json/);
  return JSON.parse(res.body.toString()) as T;
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-dash-'));
  resultsDir = path.join(tmp, 'results');
  dbPath = path.join(resultsDir, 'test.db');
  // Seeded through storage/db.ts helpers (dev-seed uses insertExperiment/finishRun/insertEvaluation/...).
  seedDevDb({ dbPath, artifactsDir: path.join(resultsDir, 'dev'), rootDir: tmp });
  fs.writeFileSync(path.join(resultsDir, 'note.txt'), 'hello');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'TOP SECRET');
  fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(resultsDir, 'link-out.txt'));
  const distDir = path.join(tmp, 'dist');
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>t</title>');
  fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log(1)');

  data = createDashboardData({ dbPath, repoRoot: tmp, resultsDir });
  server = createDashboardServer({ data, resultsDir, distDir });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((r) => server?.close(r));
  data?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('API endpoints', () => {
  it('GET /api/overview summarizes the DB and flags mock data', async () => {
    const o = await getJson<Overview>('/api/overview');
    expect(o.anyMock).toBe(true);
    expect(o.allMock).toBe(true);
    // Mock results are never the real best; they only show up as mockBest.
    expect(o.best).toBeNull();
    expect(o.mockBest?.isMock).toBe(true);
    expect(o.mockBest?.verified).toBe(true);
    expect(o.baseline?.configId).toBe('baseline');
    expect(o.baseline?.medianTokens).toBeGreaterThan(o.mockBest!.medianTokens!);
    expect(o.improvementIsMock).toBe(true);
    expect(o.improvementPct).toBeGreaterThan(0);
    expect(o.experiments.total).toBe(13);
    expect(o.experiments.running).toBe(1);
    expect(o.cost.coding.costUsd).toBeGreaterThan(0);
    expect(o.cost.evaluator.costUsd).toBeGreaterThan(0);
    expect(o.cost.research.costUsd).toBeGreaterThan(0);
    expect(o.cost.totalUsd).toBeCloseTo(o.cost.coding.costUsd + o.cost.evaluator.costUsd + o.cost.research.costUsd, 6);
  });

  it('GET /api/experiments lists every experiment with aggregates', async () => {
    const { experiments } = await getJson<{ experiments: ExperimentRow[] }>('/api/experiments');
    expect(experiments).toHaveLength(13);
    const best = experiments.find((e) => e.improvementVsBestPct === 0);
    expect(best).toBeDefined();
    const failedQuick = experiments.find((e) => e.outcome === 'failed_quick_run')!;
    expect(failedQuick.passed).toBe(false);
    expect(failedQuick.runs).toBe(1);
    const running = experiments.find((e) => e.status === 'verifying')!;
    expect(running.passed).toBeNull();
    expect(experiments.every((e) => e.isMock)).toBe(true);
  });

  it('GET /api/experiments/:id returns detail with a config diff and runs', async () => {
    const d = await getJson<ExperimentDetail>('/api/experiments/exp-0004');
    expect(d.experiment.id).toBe('exp-0004');
    expect(d.experiment.hypothesis).toMatch(/MOCK/);
    expect(d.runs).toHaveLength(3);
    expect(d.configDiff).toContain('+  "promptCaching": true');
    expect(d.configDiff).toContain('-  "promptCaching": false');
  });

  it('GET /api/experiments/:id 404s for unknown ids', async () => {
    const res = await request('GET', '/api/experiments/does-not-exist');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body.toString()).error).toMatch(/not found/i);
  });

  it('GET /api/runs/:id returns evaluation, tokens by role, screenshots and trace', async () => {
    const d = await getJson<RunDetail>('/api/runs/dev-exp-0007-r3');
    expect(d.run.passed).toBe(false);
    expect(d.run.isMock).toBe(true);
    expect(d.tokens.map((t) => t.role)).toEqual(['coding', 'evaluator']);
    const coding = d.tokens[0];
    expect(coding.totalTokens).toBe(coding.inputTokens + coding.outputTokens + coding.cacheReadTokens + coding.cacheWriteTokens);
    expect(d.evaluations[0].checks.some((c) => c.outcome === 'fail')).toBe(true);
    expect(d.screenshots.length).toBe(4);
    expect(d.screenshots[0].url).toMatch(/^\/artifacts\//);
    expect(d.trace.entries.length).toBeGreaterThan(0);
    // Screenshot URLs are actually servable.
    const img = await request('GET', d.screenshots[0].url);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
  });

  it('GET /api/runs/:id 404s for unknown runs', async () => {
    expect((await request('GET', '/api/runs/nope')).status).toBe(404);
  });

  it('GET /api/charts returns all four series', async () => {
    const c = await getJson<Charts>('/api/charts');
    expect(c.bestOverTime).toHaveLength(13);
    // Running best is monotonically non-increasing once set.
    const bests = c.bestOverTime.map((p) => p.bestTokens).filter((v): v is number => v !== null);
    for (let i = 1; i < bests.length; i++) expect(bests[i]).toBeLessThanOrEqual(bests[i - 1]);
    expect(c.scatter.length).toBeGreaterThan(20);
    expect(c.passRateByConfig.find((p) => p.configId === 'baseline')?.passRate).toBe(1);
    const totals = c.costOverTime.map((p) => p.total);
    for (let i = 1; i < totals.length; i++) expect(totals[i]).toBeGreaterThanOrEqual(totals[i - 1]);
  });

  it('unknown API paths 404', async () => {
    expect((await request('GET', '/api/nope')).status).toBe(404);
  });
});

describe('artifacts', () => {
  it('serves files under results/ with correct content types', async () => {
    const txt = await request('GET', '/artifacts/note.txt');
    expect(txt.status).toBe(200);
    expect(txt.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(txt.body.toString()).toBe('hello');
    const jsonl = await request('GET', '/artifacts/dev/runs/dev-exp-0007-r3/trace.jsonl');
    expect(jsonl.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    const json = await request('GET', '/artifacts/dev/runs/dev-exp-0007-r3/eval/dev/report.json');
    expect(json.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(json.headers['x-content-type-options']).toBe('nosniff');
  });

  it.each([
    '/artifacts/../secret.txt',
    '/artifacts/%2e%2e/secret.txt',
    '/artifacts/..%2fsecret.txt',
    '/artifacts/%2e%2e%2fsecret.txt',
    '/artifacts/dev/../../secret.txt',
    '/artifacts/dev/%2e%2e/%2e%2e/secret.txt',
    '/artifacts/..%5csecret.txt',
    '/artifacts/%00secret.txt',
    '/artifacts//etc/passwd',
    '/artifacts/link-out.txt',
    '/artifacts/test.db',
    '/artifacts/dev',
  ])('blocks %s', async (p) => {
    const res = await request('GET', p);
    expect(res.body.toString()).not.toContain('TOP SECRET');
    expect(res.body.toString()).not.toContain('SQLite format');
    expect([400, 404]).toContain(res.status);
  });

  it('resolveSafe rejects escapes directly', () => {
    expect(resolveSafe(resultsDir, '../secret.txt')).toBeNull();
    expect(resolveSafe(resultsDir, '%2e%2e/secret.txt')).toBeNull();
    expect(resolveSafe(resultsDir, 'link-out.txt')).toBeNull();
    expect(resolveSafe(resultsDir, '.hidden')).toBeNull();
    expect(resolveSafe(resultsDir, 'note.txt')).toBe(fs.realpathSync(path.join(resultsDir, 'note.txt')));
  });
});

describe('read-only', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('rejects %s with 405 on every route', async (method) => {
    for (const p of ['/api/overview', '/api/experiments', '/api/experiments/exp-0001', '/api/runs/dev-exp-0001-r1', '/artifacts/note.txt', '/']) {
      const res = await request(method, p, '{"status":"completed"}');
      expect(res.status, `${method} ${p}`).toBe(405);
      expect(res.headers.allow).toBe('GET, HEAD');
    }
  });

  it('accepts HEAD without a body', async () => {
    const res = await request('HEAD', '/api/overview');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0);
  });

  it('opens the DB with a read-only connection', () => {
    const { db } = openReadOnlyDb(dbPath);
    expect(db.raw.readonly).toBe(true);
    expect(() => db.raw.prepare(`UPDATE experiments SET notes = 'x'`).run()).toThrow();
    expect(db.listExperiments()).toHaveLength(13);
    db.close();
  });

  it('a missing DB yields an empty dashboard instead of creating the file', () => {
    const missing = path.join(tmp, 'nope', 'missing.db');
    const d = createDashboardData({ dbPath: missing, repoRoot: tmp, resultsDir });
    expect(d.overview().experiments.total).toBe(0);
    expect(d.warnings[0]).toMatch(/does not exist/);
    expect(fs.existsSync(missing)).toBe(false);
    d.close();
  });

  it('dev-seed refuses to write to benchmark.db', () => {
    expect(() => seedDevDb({ dbPath: path.join(tmp, 'benchmark.db'), artifactsDir: path.join(tmp, 'x') })).toThrow(/benchmark\.db/);
  });
});

describe('static UI', () => {
  it('serves index.html and hashed assets', async () => {
    const root = await request('GET', '/');
    expect(root.status).toBe(200);
    expect(root.headers['content-type']).toMatch(/text\/html/);
    const js = await request('GET', '/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect((await request('GET', '/assets/missing.js')).status).toBe(404);
  });
});
