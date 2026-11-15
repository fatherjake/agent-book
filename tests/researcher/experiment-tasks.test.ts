// runBenchmark on a git-diff task with INJECTED FAKE runner/evaluator (no Docker, no models).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfig } from '../../runner/types.js';
import { deterministicSeed, runBenchmark, type ExperimentDeps } from '../../researcher/experiment.js';
import { openDb, type Db } from '../../storage/db.js';
import { BASELINE_CONFIG, fakeCoding, fakeEval, makeTmp, rmTmp } from './helpers.js';

const cfg = { ...BASELINE_CONFIG, systemPrompt: 'x', skills: [], tools: [] } as unknown as AgentConfig;

describe('runBenchmark with a task (fake deps)', () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = makeTmp();
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
    rmTmp(dir);
  });

  it('passes the task to the runner, evaluates workspace.patch with the task id, stores task_id', async () => {
    const coded: Parameters<ExperimentDeps['runCodingAgent']>[0][] = [];
    const evaluated: Parameters<ExperimentDeps['evaluateRun']>[0][] = [];
    const deps: ExperimentDeps = {
      loadConfig: () => cfg,
      async runCodingAgent(o) {
        coded.push(o);
        const runDir = join(dir, 'runs', o.runId!);
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, 'workspace.patch'), 'diff --git a/a b/a\n');
        const c = fakeCoding({ runId: o.runId, tokens: 5000 });
        c.taskId = o.task;
        c.artifacts = { appSnapshotDir: join(runDir, 'app'), traceFile: join(runDir, 'trace.jsonl'), usageFile: join(runDir, 'usage.jsonl'), configSnapshotDir: join(runDir, 'config'), workspacePatch: join(runDir, 'workspace.patch') };
        return c;
      },
      async evaluateRun(o) {
        evaluated.push(o);
        return fakeEval({ runId: o.runId, passed: true });
      },
    };
    const res = await runBenchmark({ configId: 'baseline', runs: 2, taskId: 'brownfield-x', phase: 'verify', experimentId: 'exp-9', db, deps });
    expect(res.every((r) => r.passed)).toBe(true);
    expect(coded.map((c) => c.task)).toEqual(['brownfield-x', 'brownfield-x']);
    expect(evaluated.map((e) => [e.taskId, e.patchFile, e.experimentId])).toEqual(res.map((r) => ['brownfield-x', join(dir, 'runs', r.coding.runId, 'workspace.patch'), 'exp-9']));
    expect(evaluated[0].outDir).toBe(join(dir, 'runs', res[0].coding.runId, 'eval', 'dev'));
    expect(db.listRuns({ taskId: 'brownfield-x' })).toHaveLength(2);
    expect(db.listArtifacts().some((a) => a.kind === 'workspace-patch')).toBe(true);
    // Seeds differ per task; todo keeps its original seed keys.
    expect(coded[0].seed).toBe(deterministicSeed('exp-9:verify:dev:0:brownfield-x'));
  });

  it('todo: no task option reaches the runner or evaluator (unchanged call shape and seeds)', async () => {
    const coded: Parameters<ExperimentDeps['runCodingAgent']>[0][] = [];
    const evaluated: Parameters<ExperimentDeps['evaluateRun']>[0][] = [];
    const deps: ExperimentDeps = {
      loadConfig: () => cfg,
      async runCodingAgent(o) {
        coded.push(o);
        const runDir = join(dir, 'runs', o.runId!);
        mkdirSync(join(runDir, 'app'), { recursive: true });
        writeFileSync(join(runDir, 'app', 'package.json'), '{}');
        const c = fakeCoding({ runId: o.runId, tokens: 5000 });
        c.artifacts = { appSnapshotDir: join(runDir, 'app'), traceFile: join(runDir, 'trace.jsonl'), usageFile: join(runDir, 'usage.jsonl'), configSnapshotDir: join(runDir, 'config') };
        return c;
      },
      async evaluateRun(o) {
        evaluated.push(o);
        return fakeEval({ runId: o.runId, passed: true });
      },
    };
    await runBenchmark({ configId: 'baseline', runs: 1, phase: 'verify', experimentId: 'exp-9', db, deps });
    expect('task' in coded[0]).toBe(false);
    expect('taskId' in evaluated[0]).toBe(false);
    expect('patchFile' in evaluated[0]).toBe(false);
    expect(coded[0].seed).toBe(deterministicSeed('exp-9:verify:dev:0'));
    expect(db.listRuns()[0].taskId).toBe('todo');
  });
});
