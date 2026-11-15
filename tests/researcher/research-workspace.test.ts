/**
 * Research workspace construction (FAKE runs / MOCK data only: fabricated run dirs, DB rows and
 * profiles). Asserts the information-flow rules: no evaluator material, no holdout details, no eval
 * screenshots / browser-agent transcripts / reports / DB / .env, browser check messages dropped.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildResearchWorkspace,
  EVALUATOR_SOURCE_MARKERS,
  forbiddenMarkers,
  holdoutMarkers,
  scanWorkspace,
  type ProfileFns,
} from '../../researcher/research-workspace.js';
import { joinResearchText, splitResearchText } from '../../researcher/history.js';
import { readConfigFiles } from '../../researcher/optimizer.js';
import { openDb, type Db } from '../../storage/db.js';
import { fakeCoding, fakeEval, makeConfigsRoot, makeTmp, rmTmp } from './helpers.js';

process.env.FRUGAL_QUIET = '1';

const REPO = process.cwd();
const SPEC = join(REPO, 'benchmark', 'spec');

/** MOCK profile functions (the real ones are researcher/session-profile.ts). */
const fakeProfile: ProfileFns = {
  buildSessionProfile: (runDir: string) => ({ mock: true, runDir: relative(REPO, runDir).length, calls: 4 }),
  renderProfileMarkdown: () => '# MOCK profile\n\n| call | tokens |\n|---|---|\n| 1 | 26252 |\n',
};

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, n.name);
    if (n.isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).split(sep).join('/'));
  }
  return out.sort();
}

/** Fabricate a run dir that ALSO contains eval material that must never be copied. */
function makeRunDir(results: string, runId: string, extra: Record<string, string> = {}) {
  const d = join(results, 'runs', runId);
  mkdirSync(join(d, 'eval', 'dev', 'screenshots'), { recursive: true });
  mkdirSync(join(d, 'eval', 'dev', 'browser-agent'), { recursive: true });
  mkdirSync(join(d, 'app', 'backend'), { recursive: true });
  mkdirSync(join(d, 'config'), { recursive: true });
  writeFileSync(join(d, 'claude-stream.jsonl'), '{"type":"system","subtype":"init","tools":["Bash","Read"]}\n{"type":"result","subtype":"success"}\n');
  writeFileSync(join(d, 'usage.jsonl'), '{"role":"coding","totalTokens":26252,"cacheReadTokens":10760}\n');
  writeFileSync(join(d, 'trace.jsonl'), '{"type":"model_call","turn":1}\n');
  writeFileSync(join(d, 'run.json'), JSON.stringify({ runId, status: 'completed', usage: { totalTokens: 123678 } }));
  writeFileSync(join(d, 'eval', 'dev', 'report.json'), '{"secret":"SCENARIO GOAL TEXT"}');
  writeFileSync(join(d, 'eval', 'dev', 'screenshots', 'ui.png'), 'PNG');
  writeFileSync(join(d, 'eval', 'dev', 'browser-agent', 'transcript.jsonl'), '{"goal":"hidden"}');
  writeFileSync(join(d, 'eval', 'dev', 'app.log'), 'log');
  writeFileSync(join(d, 'app', 'backend', 'server.js'), 'APP SNAPSHOT SOURCE');
  for (const [k, v] of Object.entries(extra)) writeFileSync(join(d, k), v);
  return d;
}

describe('research workspace (MOCK runs)', () => {
  let dir: string;
  let configs: string;
  let results: string;
  let db: Db;
  const holdoutTitle = holdoutMarkers(REPO).find((m) => m.includes(' '))!;

  beforeEach(() => {
    dir = makeTmp('frugal-ws-');
    configs = makeConfigsRoot(dir);
    results = join(dir, 'results');
    db = openDb(join(results, 'benchmark.db'));
    // baseline experiment: 2 dev verify runs (1 failing with a browser + an api failure) and a holdout run.
    const exp = db.insertExperiment({ kind: 'baseline', parentConfigId: null, candidateConfigId: 'baseline', hypothesis: 'Baseline verification', provider: 'anthropic', model: 'm', status: 'verifying' });
    const mk = (runId: string, suite: 'dev' | 'holdout', passed: boolean, checks?: Parameters<typeof fakeEval>[0]['checks']) => {
      db.insertRunStart({ runId, experimentId: exp.id, configId: 'baseline', seed: 1, phase: suite === 'holdout' ? 'holdout' : 'verify', suite, usedMockProvider: false });
      db.finishRun(runId, fakeCoding({ runId, configId: 'baseline', tokens: 1000, experimentId: exp.id }), passed);
      db.insertEvaluation(fakeEval({ runId, passed, suite, checks }));
    };
    mk('run-dev-1', 'dev', true);
    mk('run-dev-2', 'dev', false, [
      { id: 'ui.edit.save', category: 'browser', mandatory: true, outcome: 'fail', message: 'BROWSER SCENARIO DETAIL must not leak', attempts: 1 },
      { id: 'api.create.valid', category: 'backend', mandatory: true, outcome: 'fail', message: 'expected 201, got 500', attempts: 1 },
    ]);
    mk('run-holdout-1', 'holdout', false, [{ id: 'holdout.secret.check', category: 'backend', mandatory: true, outcome: 'fail', message: 'HOLDOUT DETAIL', attempts: 1 }]);
    db.updateExperiment(exp.id, { status: 'completed', outcome: 'baseline', holdoutPassed: false });
    // candidate experiment with evidence stored in the hypothesis text
    db.insertExperiment({
      kind: 'candidate',
      parentConfigId: 'baseline',
      candidateConfigId: null,
      hypothesis: joinResearchText('Replace mode saves overhead', 'run-dev-1 call 2: 26k cache read', '-15k/call'),
      provider: 'anthropic',
      model: 'm',
      status: 'rejected',
    });
    makeRunDir(results, 'run-dev-1');
    makeRunDir(results, 'run-dev-2');
    makeRunDir(results, 'run-holdout-1');
  });
  afterEach(() => {
    db.close();
    rmTmp(dir);
  });

  const build = (o: Partial<Parameters<typeof buildResearchWorkspace>[0]> = {}) =>
    buildResearchWorkspace({
      db,
      resultsDir: results,
      configsRoot: configs,
      specDir: SPEC,
      repoRoot: REPO,
      bestConfigId: 'baseline',
      bestConfigFiles: readConfigFiles('baseline', configs),
      history: 'BEST VERIFIED: none yet',
      whitelist: { allowModelChange: false, backend: 'claude-code' },
      experimentIndex: 1,
      singleVariableExperiments: 8,
      verificationRuns: 5,
      agentLimits: { maxRuntimeSec: 900, maxTotalTokens: 1_500_000 },
      profile: fakeProfile,
      ...o,
    });

  it('has the documented layout and only the allowed run files', async () => {
    const ws = await build();
    try {
      const files = walk(ws.dir);
      expect(files).toContain('README.md');
      expect(files).toContain('digest.md');
      expect(files).toContain('best-config/config.json');
      expect(files).toContain('best-config/skills/api.md');
      expect(files).toContain('spec/requirements.md');
      expect(files).toContain('spec/design.png');
      for (const f of ['profile.md', 'profile.json', 'claude-stream.jsonl', 'usage.jsonl', 'trace.jsonl', 'run.json', 'eval-summary.json'])
        expect(files).toContain(`runs/run-dev-2/${f}`);
      expect(ws.runs.sort()).toEqual(['run-dev-1', 'run-dev-2']);
      expect(files.some((f) => f.startsWith('runs/run-holdout-1'))).toBe(false);
      expect(files.some((f) => /^runs\/[^/]+\/(eval|app|config)\//.test(f))).toBe(false);
      expect(ws.experiments).toHaveLength(2);
      const meta = JSON.parse(readFileSync(join(ws.dir, 'experiments', ws.experiments[1], 'meta.json'), 'utf8'));
      expect(meta).toMatchObject({ hypothesis: 'Replace mode saves overhead', evidence: 'run-dev-1 call 2: 26k cache read', expectedSavings: '-15k/call' });
      const outcome = JSON.parse(readFileSync(join(ws.dir, 'experiments', ws.experiments[0], 'outcome.json'), 'utf8'));
      expect(outcome.holdoutPassed).toBe(false); // one bit only
      const readme = readFileSync(join(ws.dir, 'README.md'), 'utf8');
      expect(readme).toContain('visual similarity to the reference design >= 95');
      expect(readme).toContain('NEVER embed application code');
      expect(readme).toContain('5 verification runs');
      expect(readme).toContain('/opt/frugal/bin'); // exact surface text from whitelist.claudeCodeSurfaceDoc()
      expect(readme).toContain('ANTI-CHEATING GUARD');
      expect(readme).toContain('runs/run-dev-2');
    } finally {
      ws.cleanup();
    }
    expect(existsSync(ws.dir)).toBe(false);
  });

  it('eval-summary has DEV check outcomes, non-browser messages only, and the visual score', async () => {
    const ws = await build();
    try {
      const ev = JSON.parse(readFileSync(join(ws.dir, 'runs', 'run-dev-2', 'eval-summary.json'), 'utf8'));
      expect(ev.suite).toBe('dev');
      expect(ev.visualScore).toBe(97);
      expect(ev.failedChecks).toEqual(['ui.edit.save', 'api.create.valid']);
      expect(ev.checks['api.create.valid'].message).toBe('expected 201, got 500');
      expect(ev.checks['ui.edit.save'].message).toBeUndefined();
    } finally {
      ws.cleanup();
    }
  });

  it('FORBIDDEN-CONTENT: no evaluator / holdout / eval material anywhere in the workspace', async () => {
    const ws = await build();
    try {
      const markers = forbiddenMarkers(REPO);
      expect(markers.length).toBeGreaterThan(EVALUATOR_SOURCE_MARKERS.length); // holdout titles were loaded
      expect(markers).toContain(holdoutTitle);
      const scan = scanWorkspace(ws.dir, markers);
      expect(scan.forbiddenPaths).toEqual([]);
      expect(scan.forbiddenContent).toEqual([]);
      const all = walk(ws.dir)
        .filter((f) => !f.endsWith('.png'))
        .map((f) => readFileSync(join(ws.dir, f), 'utf8'))
        .join('\n');
      for (const s of ['HOLDOUT DETAIL', 'holdout.secret.check', 'run-holdout-1', 'BROWSER SCENARIO DETAIL', 'SCENARIO GOAL TEXT', 'APP SNAPSHOT SOURCE', holdoutTitle])
        expect(all).not.toContain(s);
      // evaluator source files never appear (their distinctive first lines)
      const evalSrc = readFileSync(join(REPO, 'evaluator', 'scenarios', 'ui-scenarios.ts'), 'utf8').split('\n').slice(1, 3).join('\n');
      expect(all).not.toContain(evalSrc);
      const names = walk(ws.dir);
      for (const bad of [/evaluator/i, /holdout/i, /screenshot/i, /browser-agent/i, /report\.json$/, /\.db$/, /\.env/, /app\.log$/])
        expect(names.filter((n) => bad.test(n))).toEqual([]);
    } finally {
      ws.cleanup();
    }
  });

  it('a run file that contains hidden material is removed by the final scan', async () => {
    writeFileSync(join(results, 'runs', 'run-dev-1', 'trace.jsonl'), JSON.stringify({ leaked: holdoutTitle }) + '\n');
    const ws = await build();
    try {
      expect(existsSync(join(ws.dir, 'runs', 'run-dev-1', 'trace.jsonl'))).toBe(false);
      expect(existsSync(join(ws.dir, 'runs', 'run-dev-1', 'usage.jsonl'))).toBe(true);
      expect(ws.notes.join('\n')).toContain('runs/run-dev-1/trace.jsonl: removed');
      expect(scanWorkspace(ws.dir, forbiddenMarkers(REPO)).forbiddenContent).toEqual([]);
    } finally {
      ws.cleanup();
    }
  });

  it('scanWorkspace flags forbidden paths (fail-closed check)', () => {
    const d = makeTmp('frugal-ws-scan-');
    try {
      for (const p of ['runs/r/eval/dev/report.json', 'runs/r/screenshots/a.png', 'evaluator/x.ts', 'results/benchmark.db', '.env', 'runs/r/app/server.js', 'runs/r/x.png'])
        mkdirSync(join(d, p, '..'), { recursive: true }), writeFileSync(join(d, p), 'x');
      const s = scanWorkspace(d, []);
      expect(s.forbiddenPaths.length).toBeGreaterThanOrEqual(7);
    } finally {
      rmTmp(d);
    }
  });

  it('caps runs by count and bytes and truncates large files at a line boundary', async () => {
    const big = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(50) })).join('\n') + '\n';
    writeFileSync(join(results, 'runs', 'run-dev-2', 'claude-stream.jsonl'), big);
    const ws = await build({ limits: { maxRuns: 1, maxFileBytes: 10_000 } });
    try {
      expect(ws.runs).toHaveLength(1);
      const f = join(ws.dir, 'runs', ws.runs[0], 'claude-stream.jsonl');
      if (ws.runs[0] === 'run-dev-2') {
        const lines = readFileSync(f, 'utf8').trim().split('\n');
        for (const l of lines) JSON.parse(l); // still valid jsonl
        expect(lines.at(-1)).toContain('frugal_truncated');
      }
    } finally {
      ws.cleanup();
    }
  });

  it('works without profiles (notes say so)', async () => {
    const ws = await build({ profile: null });
    try {
      expect(existsSync(join(ws.dir, 'runs', 'run-dev-1', 'profile.md'))).toBe(false);
      expect(readFileSync(join(ws.dir, 'README.md'), 'utf8')).toContain('session profiles cannot be built here');
    } finally {
      ws.cleanup();
    }
  });

  it('copies the profile the runner already wrote instead of rebuilding it', async () => {
    writeFileSync(join(results, 'runs', 'run-dev-1', 'profile.json'), '{"version":1,"fromRunner":true}');
    writeFileSync(join(results, 'runs', 'run-dev-1', 'profile.md'), '# RUNNER PROFILE\n');
    const ws = await build();
    try {
      expect(readFileSync(join(ws.dir, 'runs', 'run-dev-1', 'profile.md'), 'utf8')).toBe('# RUNNER PROFILE\n');
      expect(readFileSync(join(ws.dir, 'runs', 'run-dev-2', 'profile.md'), 'utf8')).toContain('MOCK profile'); // built when missing
      expect(readFileSync(join(ws.dir, 'README.md'), 'utf8')).toContain('NUMBER OF TURNS drives cost');
    } finally {
      ws.cleanup();
    }
  });

  it('splitResearchText round-trips evidence and expected savings', () => {
    const t = joinResearchText('H', 'E line', 'S');
    expect(splitResearchText(t)).toEqual({ hypothesis: 'H', evidence: 'E line', expectedSavings: 'S' });
    expect(splitResearchText('plain')).toEqual({ hypothesis: 'plain' });
  });
});
