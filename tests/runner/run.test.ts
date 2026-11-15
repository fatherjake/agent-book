import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../runner/config.js';
import { MockProvider } from '../../runner/providers/mock.js';
import { effectiveLimits, newRunId, runCodingAgent } from '../../runner/run.js';
import { hashConfig } from '../../runner/config.js';
import { FakeSandbox } from './fake-sandbox.js';

const image = { image: 'fake:1', imageId: 'sha256:img', starterHash: 'abc' };

function setup() {
  const resultsDir = mkdtempSync(join(tmpdir(), 'res-'));
  const specDir = mkdtempSync(join(tmpdir(), 'spec-'));
  writeFileSync(join(specDir, 'requirements.md'), '# Reqs');
  return { resultsDir, specDir };
}

describe('runCodingAgent (fake sandbox, mock provider)', () => {
  it('runId format', () => {
    expect(newRunId(new Date(Date.UTC(2026, 10, 14, 1, 2, 3)))).toMatch(/^run_20261114010203_[0-9a-f]{6}$/);
  });

  it('completes, writes run.json/usage/trace/config, destroys the sandbox', async () => {
    const { resultsDir, specDir } = setup();
    const sb = new FakeSandbox();
    const r = await runCodingAgent({
      config: { ...loadConfig('baseline-api'), provider: 'mock' },
      seed: 1,
      experimentId: 'exp1',
      provider: new MockProvider(),
      resultsDir,
      specDir,
      image,
      sandboxFactory: async () => sb,
    });
    expect(r.status).toBe('completed');
    expect(r.usedMockProvider).toBe(true);
    expect(r.usage.modelCalls).toBe(2);
    expect(r.usage.anyEstimated).toBe(true);
    expect(r).toMatchObject({ imageId: 'sha256:img', starterHash: 'abc', toolCalls: 1, experimentId: 'exp1' });
    expect(r.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sb.destroyed).toBe(true);
    expect(sb.copiedOut[0].from).toBe('/workspace');
    const runDir = join(resultsDir, 'runs', r.runId);
    expect(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')).runId).toBe(r.runId);
    expect(readFileSync(join(runDir, 'usage.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(existsSync(join(runDir, 'trace.jsonl'))).toBe(true);
    expect(existsSync(join(runDir, 'config', 'system-prompt.md'))).toBe(true);
    expect(r.artifacts.appSnapshotDir.endsWith(`runs/${r.runId}/app`)).toBe(true);
  });

  it('sandbox creation failure → infra_error with run.json, no throw', async () => {
    const { resultsDir, specDir } = setup();
    const r = await runCodingAgent({
      config: loadConfig('baseline-api'),
      seed: 1,
      provider: new MockProvider(),
      resultsDir,
      specDir,
      image,
      sandboxFactory: async () => {
        throw new Error('docker daemon not running');
      },
    });
    expect(r.status).toBe('infra_error');
    expect(r.failureReason).toMatch(/docker daemon/);
    expect(existsSync(join(resultsDir, 'runs', r.runId, 'run.json'))).toBe(true);
  });

  it('snapshot failure → infra_error but sandbox still destroyed', async () => {
    const { resultsDir, specDir } = setup();
    const sb = new FakeSandbox();
    sb.failCopyOut = true;
    const r = await runCodingAgent({ config: loadConfig('baseline-api'), seed: 1, provider: new MockProvider(), resultsDir, specDir, image, sandboxFactory: async () => sb });
    expect(r.status).toBe('infra_error');
    expect(r.failureReason).toMatch(/snapshot failed/);
    expect(sb.destroyed).toBe(true);
  });

  it('missing API key for the anthropic provider is recorded, not thrown', async () => {
    const { resultsDir, specDir } = setup();
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = '';
    try {
      const sb = new FakeSandbox();
      const r = await runCodingAgent({ config: loadConfig('baseline-api'), seed: 1, resultsDir, specDir, image, sandboxFactory: async () => sb });
      expect(r.status).toBe('infra_error');
      expect(r.failureReason).toMatch(/ANTHROPIC_API_KEY/);
      expect(r.usedMockProvider).toBe(false);
      expect(sb.destroyed).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('effectiveLimits only tightens', () => {
    const base = { maxTotalTokens: 1000, maxModelCalls: 10, maxRuntimeSec: 60 };
    expect(effectiveLimits(base, { maxTotalTokens: 500, maxModelCalls: 50 })).toEqual({ maxTotalTokens: 500, maxModelCalls: 10, maxRuntimeSec: 60 });
    expect(effectiveLimits(base, { maxRuntimeSec: 0, maxModelCalls: NaN })).toEqual(base);
    expect(effectiveLimits(base)).toEqual(base);
  });

  it('limitsOverride is enforced, recorded, and does not change configHash', async () => {
    const { resultsDir, specDir } = setup();
    const config = { ...loadConfig('baseline-api'), provider: 'mock' };
    const r = await runCodingAgent({
      config,
      seed: 1,
      provider: new MockProvider({ type: 'loop' }),
      resultsDir,
      specDir,
      image,
      sandboxFactory: async () => new FakeSandbox(),
      limitsOverride: { maxModelCalls: 3, maxTotalTokens: 10_000_000_000 },
    });
    expect(r.status).toBe('limit_exceeded');
    expect(r.failureReason).toMatch(/maxModelCalls \(3\)/);
    expect(r.effectiveLimits).toEqual({ ...config.limits, maxModelCalls: 3 });
    expect(r.configHash).toBe(hashConfig(config));
    const runDir = join(resultsDir, 'runs', r.runId);
    expect(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')).effectiveLimits.maxModelCalls).toBe(3);
    const start = JSON.parse(readFileSync(join(runDir, 'trace.jsonl'), 'utf8').split('\n')[0]);
    expect(start).toMatchObject({ type: 'start', limits: { maxModelCalls: 3, maxTotalTokens: config.limits.maxTotalTokens } });
    expect(readFileSync(join(runDir, 'config', 'hash.txt'), 'utf8').trim()).toBe(r.configHash);
  });
});
