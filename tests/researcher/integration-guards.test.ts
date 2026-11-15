/**
 * Integration guards (FAKE data, no Docker, no models):
 *  - evaluations that skipped the LLM browser agent never count toward promotion
 *    (summarize, research loop, db.recordPromotion);
 *  - the research history never reads holdout report files or holdout check messages;
 *  - runBenchmark creates a fresh provider per run (stateful mock scripts);
 *  - the scripted mock research agent yields whitelist-valid proposals.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfig, ModelProvider } from '../../runner/types.js';
import { runBenchmark, summarize, type BenchmarkRunResult, type ExperimentDeps } from '../../researcher/experiment.js';
import { buildHistoryDigest } from '../../researcher/history.js';
import { runResearchLoop } from '../../researcher/loop.js';
import { MockResearchProvider } from '../../researcher/mock-research-provider.js';
import { createResearchAgent } from '../../researcher/research-agent.js';
import { DEFAULT_RESEARCH_SETTINGS, type ResearchSettings } from '../../researcher/settings.js';
import { resolveMockScript } from '../../researcher/mock-scripts.js';
import { MockProvider } from '../../runner/providers/mock.js';
import { openDb, type Db } from '../../storage/db.js';
import { BASELINE_CONFIG, fakeCoding, fakeEval, makeConfigsRoot, makeFakeBench, makeFakeClock, makeTmp, rmTmp, type Plan } from './helpers.js';

const settings = (o: Partial<ResearchSettings> = {}): ResearchSettings => ({
  ...DEFAULT_RESEARCH_SETTINGS,
  verificationRuns: 3,
  maxExperiments: 1,
  maxResearchCostUsd: 1000,
  quickRunMaxTokenRatio: null,
  holdout: { onPromotion: true, runs: 1 },
  ...o,
});

const r = (o: { passed: boolean; tokens: number; noBrowser?: boolean; mock?: boolean }): BenchmarkRunResult => {
  const coding = fakeCoding({ tokens: o.tokens, mock: o.mock });
  return { coding, evaluation: fakeEval({ runId: coding.runId, passed: o.passed, browserAgentSkipped: o.noBrowser }), passed: o.passed };
};

describe('[NO-BROWSER-AGENT] evaluations never qualify', () => {
  it('summarize: one skipped browser agent → not meetsQualityRequirements, flag set', () => {
    const full = summarize([r({ passed: true, tokens: 100 }), r({ passed: true, tokens: 200 })]);
    expect(full.meetsQualityRequirements).toBe(true);
    expect(full.browserAgentSkipped).toBe(false);
    const partial = summarize([r({ passed: true, tokens: 100 }), r({ passed: true, tokens: 200, noBrowser: true })]);
    expect(partial.passes).toBe(2);
    expect(partial.meetsQualityRequirements).toBe(false);
    expect(partial.browserAgentSkipped).toBe(true);
  });

  describe('storage', () => {
    let db: Db;
    beforeEach(() => {
      db = openDb(':memory:');
    });
    afterEach(() => db.close());

    const qualifying = (configId = 'baseline') => ({
      ...summarize([r({ passed: true, tokens: 100 })], configId),
      meetsQualityRequirements: true,
    });

    it('persists the flag and aggregates it per experiment and overview', () => {
      const exp = db.insertExperiment({ kind: 'manual', parentConfigId: null, candidateConfigId: 'baseline', hypothesis: 'h', provider: 'mock', model: 'm', status: 'running' });
      db.insertRunStart({ runId: 'r1', experimentId: exp.id, configId: 'baseline', seed: 1, phase: 'manual', suite: 'dev' });
      db.finishRun('r1', fakeCoding({ runId: 'r1' }), true);
      db.insertEvaluation(fakeEval({ runId: 'r1', passed: true, browserAgentSkipped: true }));
      expect(db.listEvaluations('r1')[0].browserAgentSkipped).toBe(true);
      expect(db.listExperimentsWithAggregates()[0].anyBrowserAgentSkipped).toBe(true);
      expect(db.getOverview().anyBrowserAgentSkipped).toBe(true);
    });

    it('recordPromotion refuses a summary flagged browserAgentSkipped', () => {
      const exp = db.insertExperiment({ kind: 'baseline', parentConfigId: null, candidateConfigId: 'baseline', hypothesis: 'h', provider: 'anthropic', model: 'm' });
      expect(() => db.recordPromotion({ experimentId: exp.id, configId: 'baseline', summary: { ...qualifying(), browserAgentSkipped: true } })).toThrow(/NO-BROWSER-AGENT/);
      expect(db.getBestVerified()).toBeNull();
    });

    it('recordPromotion refuses when any stored evaluation of the experiment skipped the browser agent, even if the summary lies', () => {
      const exp = db.insertExperiment({ kind: 'baseline', parentConfigId: null, candidateConfigId: 'baseline', hypothesis: 'h', provider: 'anthropic', model: 'm' });
      db.insertRunStart({ runId: 'v1', experimentId: exp.id, configId: 'baseline', seed: 1, phase: 'verify', suite: 'dev' });
      db.finishRun('v1', fakeCoding({ runId: 'v1' }), true);
      db.insertEvaluation(fakeEval({ runId: 'v1', passed: true, browserAgentSkipped: true }));
      expect(() => db.recordPromotion({ experimentId: exp.id, configId: 'baseline', summary: qualifying() })).toThrow(/skipped the browser agent/);
      expect(db.getBestVerified()).toBeNull();
    });

    it('recordPromotion still accepts full evaluations', () => {
      const exp = db.insertExperiment({ kind: 'baseline', parentConfigId: null, candidateConfigId: 'baseline', hypothesis: 'h', provider: 'anthropic', model: 'm' });
      db.insertRunStart({ runId: 'v1', experimentId: exp.id, configId: 'baseline', seed: 1, phase: 'verify', suite: 'dev' });
      db.finishRun('v1', fakeCoding({ runId: 'v1' }), true);
      db.insertEvaluation(fakeEval({ runId: 'v1', passed: true, browserAgentSkipped: false }));
      expect(db.recordPromotion({ experimentId: exp.id, configId: 'baseline', summary: qualifying() }).configId).toBe('baseline');
    });
  });

  describe('research loop', () => {
    let dir: string;
    let configs: string;
    let results: string;
    let db: Db;
    beforeEach(() => {
      dir = makeTmp();
      configs = makeConfigsRoot(dir);
      results = join(dir, 'results');
      db = openDb(join(results, 'benchmark.db'));
    });
    afterEach(() => {
      db.close();
      rmTmp(dir);
    });

    const agent = {
      async propose() {
        return { proposal: { hypothesis: 'fake hypothesis (test)', changeSummary: 'fake change (test)', files: { 'system-prompt.md': 'FAKE\n' } }, usage: [], attempts: 1 };
      },
    };

    it('all runs pass but with skipBrowserAgent → baseline not promoted, candidate not_better, best stays empty', async () => {
      const plan: Plan = (cfg) => ({ passed: true, tokens: cfg === 'baseline' ? 1000 : 500 });
      const bench = makeFakeBench(db, plan);
      const res = await runResearchLoop(
        { db, runBenchmark: bench.fn, researchAgent: agent, clock: makeFakeClock() },
        { settings: settings({ skipBrowserAgent: true }), paths: { configsRoot: configs, resultsDir: results } },
      );
      expect(bench.calls.every((c) => c.skipBrowserAgent === true)).toBe(true);
      expect(res.best).toBeNull();
      expect(db.getBestHistory()).toHaveLength(0);
      const [base, cand] = db.listExperiments();
      expect(base.summary?.meetsQualityRequirements).toBe(false);
      expect(base.summary?.browserAgentSkipped).toBe(true);
      expect([cand.outcome, cand.error]).toEqual(['not_better', null]);
      expect(cand.notes).toContain('[NO-BROWSER-AGENT]');
      expect(db.listExperimentsWithAggregates().every((e) => e.anyBrowserAgentSkipped)).toBe(true);
    });
  });
});

describe('history digest never reads holdout reports', () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = makeTmp();
    db = openDb(join(dir, 'benchmark.db'));
  });
  afterEach(() => {
    db.close();
    rmTmp(dir);
  });

  it('history.ts has no filesystem access at all (it can only see DB rows)', () => {
    const src = readFileSync(join(import.meta.dirname, '../../researcher/history.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"](node:)?fs['"]/);
    expect(src).not.toMatch(/readFileSync|readdirSync|createReadStream|reportPath|reportFile/);
  });

  it('a holdout report.json on disk with secret details never reaches the digest; only the pass/fail bit does', () => {
    const exp = db.insertExperiment({ kind: 'baseline', parentConfigId: null, candidateConfigId: 'baseline', hypothesis: 'h', provider: 'anthropic', model: 'm', status: 'verifying' });
    const reportDir = join(dir, 'runs', 'h1', 'eval', 'holdout');
    mkdirSync(reportDir, { recursive: true });
    const reportFile = join(reportDir, 'report.json');
    writeFileSync(reportFile, JSON.stringify({ details: { titles: ['SECRET-HOLDOUT-TITLE'] }, summary: 'SECRET-HOLDOUT-SUMMARY' }));
    db.insertRunStart({ runId: 'h1', experimentId: exp.id, configId: 'baseline', seed: 9, phase: 'holdout', suite: 'holdout' });
    db.finishRun('h1', fakeCoding({ runId: 'h1' }), false);
    const ev = fakeEval({
      runId: 'h1',
      suite: 'holdout',
      passed: false,
      checks: [{ id: 'ui.secret-holdout-check', category: 'functional', mandatory: true, outcome: 'fail', message: 'SECRET-HOLDOUT-MESSAGE', attempts: 1 }],
    });
    ev.reportFile = reportFile;
    ev.failureSummary = 'SECRET-HOLDOUT-FAILURE-SUMMARY';
    db.insertEvaluation(ev);
    db.updateExperiment(exp.id, { holdoutPassed: false, status: 'completed', outcome: 'baseline' });

    const digest = buildHistoryDigest(db);
    expect(digest).toContain('holdout: failed');
    for (const secret of ['SECRET-HOLDOUT', 'ui.secret-holdout-check', reportFile, 'report.json']) expect(digest).not.toContain(secret);
  });
});

describe('runBenchmark providerFactory', () => {
  it('creates a fresh provider for every run (a stateful mock script is not exhausted after run 1)', async () => {
    const cfg = { ...BASELINE_CONFIG, systemPrompt: 'x', skills: [], tools: [] } as unknown as AgentConfig;
    const seen: ModelProvider[] = [];
    const deps: ExperimentDeps = {
      loadConfig: () => cfg,
      async runCodingAgent(o) {
        seen.push(o.provider!);
        return fakeCoding({ runId: o.runId, status: 'agent_error', mock: true });
      },
      async evaluateRun() {
        throw new Error('not reached');
      },
    };
    let made = 0;
    const res = await runBenchmark({ configId: 'baseline', runs: 3, deps, providerFactory: () => (made++, new MockProvider()) });
    expect(res).toHaveLength(3);
    expect(made).toBe(3);
    expect(new Set(seen).size).toBe(3);
    expect(seen.every((p) => p.isMock)).toBe(true);
  });
});

describe('mock scripts and mock research agent (infra tests)', () => {
  it('reference-app script writes the reference app sources, never node_modules/dist', async () => {
    const p = new MockProvider(resolveMockScript('reference-app'));
    const paths: string[] = [];
    for (let i = 0; i < 50; i++) {
      const res = await p.complete({ model: 'm', system: '', messages: [], maxOutputTokens: 10 });
      for (const b of res.content) if (b.type === 'tool_use') paths.push(String(b.input.path));
      if (res.stopReason === 'end_turn') break;
    }
    expect(paths).toContain('/workspace/backend/server.js');
    expect(paths).toContain('/workspace/frontend/src/App.jsx');
    expect(paths.some((x) => /node_modules|\/dist\//.test(x))).toBe(false);
    expect(() => resolveMockScript('nope')).toThrow(/unknown mock script/);
  });

  it('MockResearchProvider yields valid, distinct, [MOCK]-labelled proposals through the real research agent', async () => {
    const dir = makeTmp();
    try {
      const agent = createResearchAgent({ provider: new MockResearchProvider(), model: 'mock-research' });
      const input = {
        bestConfigId: 'baseline',
        bestConfigFiles: { 'system-prompt.md': 'x', 'config.json': '{}' },
        history: 'none',
        experimentIndex: 1,
        singleVariableExperiments: 8,
        whitelist: { allowModelChange: false },
      };
      const a = await agent.propose(input);
      const b = await agent.propose({ ...input, experimentIndex: 2 });
      expect(a.attempts).toBe(1);
      expect(a.proposal.hypothesis).toContain('[MOCK]');
      expect(Object.keys(a.proposal.files)).toEqual(['skills/mock-note-1.md']);
      expect(Object.keys(b.proposal.files)).toEqual(['skills/mock-note-2.md']);
      expect(a.usage).toHaveLength(1);
      expect(a.usage[0].role).toBe('research');
      expect(a.usage[0].usageEstimated).toBe(true);
      expect(a.usage[0].costUsd).toBe(0);
    } finally {
      rmTmp(dir);
    }
  });
});
