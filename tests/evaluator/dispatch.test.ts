/** evaluateRun dispatch by task (FAKE task evaluators; no Docker, no browser). */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateRun, type EvaluateTaskOptions } from '../../evaluator/index.js';
import type { EvaluationResult } from '../../runner/types.js';
import type { Task } from '../../runner/tasks.js';

const fakeTask = (browserAgent: 'none' | 'required') => ({ id: 'mastodon-x', browserAgent, evaluator: 'evaluator/tasks/mastodon-x/index.ts' }) as unknown as Task;

const fakeResult = (o: EvaluateTaskOptions, passed: boolean): EvaluationResult => ({
  runId: o.runId,
  suite: o.suite,
  seed: o.seed,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  appStarted: true,
  checks: [{ id: 'api.fake', category: 'backend', mandatory: true, outcome: passed ? 'pass' : 'fail', attempts: 1 }],
  visualScore: 100,
  visualThreshold: 0,
  passed,
  evaluatorFailure: false,
  evaluatorUsage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, modelCalls: 0, anyEstimated: false },
  reportFile: join(o.outDir, 'report.json'),
});

describe('evaluateRun dispatch by task', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'frugal-dispatch-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("routes a non-todo task to its evaluateTask with the patch, suite, seed, outDir and base image", async () => {
    const calls: EvaluateTaskOptions[] = [];
    const r = await evaluateRun({
      runId: 'run-1',
      appDir: join(dir, 'runs', 'run-1', 'app'),
      suite: 'holdout',
      seed: 7,
      outDir: join(dir, 'out'),
      taskId: 'mastodon-x',
      experimentId: 'exp-0002',
      skipBrowserAgent: true,
      taskDeps: {
        getTask: () => fakeTask('none'),
        loadEvaluator: async () => async (o) => (calls.push(o), fakeResult(o, true)),
        ensureTaskImage: async () => ({ baseImage: 'frugal-task-mastodon-x:abc' }),
      },
    });
    expect(calls).toEqual([
      { runId: 'run-1', patchFile: join(dir, 'runs', 'run-1', 'workspace.patch'), suite: 'holdout', seed: 7, outDir: join(dir, 'out'), image: 'frugal-task-mastodon-x:abc', taskId: 'mastodon-x', experimentId: 'exp-0002' },
    ]);
    expect(r.passed).toBe(true);
    // browserAgent 'none': complete (promotable) even with skipBrowserAgent.
    expect(r.browserAgentSkipped).toBe(false);
  });

  it("browserAgent 'required' tasks keep the NO-BROWSER-AGENT rule", async () => {
    const r = await evaluateRun({
      runId: 'run-2',
      appDir: '',
      patchFile: join(dir, 'p.patch'),
      suite: 'dev',
      seed: 1,
      outDir: join(dir, 'out2'),
      taskId: 'mastodon-x',
      skipBrowserAgent: true,
      image: 'img:1',
      taskDeps: { getTask: () => fakeTask('required'), loadEvaluator: async () => async (o) => fakeResult(o, true) },
    });
    expect(r.browserAgentSkipped).toBe(true);
  });

  it('a crashing or missing task evaluator is an evaluator failure, never thrown, with a report', async () => {
    const r = await evaluateRun({
      runId: 'run-3',
      appDir: '',
      suite: 'dev',
      seed: 1,
      outDir: join(dir, 'out3'),
      taskId: 'mastodon-x',
      image: 'img:1',
      taskDeps: {
        getTask: () => fakeTask('none'),
        loadEvaluator: async () => {
          throw new Error('evaluator/tasks/mastodon-x/index.ts does not export evaluateTask()');
        },
      },
    });
    expect(r.passed).toBe(false);
    expect(r.evaluatorFailure).toBe(true);
    expect(r.checks[0].outcome).toBe('error');
    expect(existsSync(join(dir, 'out3', 'report.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'out3', 'report.json'), 'utf8')).taskId).toBe('mastodon-x');
  });
});
