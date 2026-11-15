/**
 * DEVELOPMENT ONLY: seed a separate, clearly fake database for building the dashboard UI.
 *
 *   npx tsx dashboard/dev-seed.ts            # writes results/dev-dashboard.db + results/dev-dashboard/
 *   npm run dashboard -- --db results/dev-dashboard.db
 *
 * Every experiment, run and session is marked mock (is_mock / used_mock_provider), so the
 * dashboard shows [MOCK] everywhere. This script refuses to write to results/benchmark.db.
 * Data is written through storage/db.ts helpers so it matches the real schema.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { openDb, type StoredSummary } from '../storage/db.js';
import type { CheckResult, CodingRunResult, EvaluationResult, TokenTotals, UsageRecord } from '../runner/types.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface SeedOptions {
  dbPath: string;
  /** Directory for fake artifact files (must be inside results/ to be served). */
  artifactsDir: string;
  experiments?: number;
  /** Root that stored paths are relative to (default: repo root). */
  rootDir?: string;
}

// Deterministic PRNG so the dev data is stable between seeds.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

function writeFile(file: string, content: string | Buffer): { sha256: string; bytes: number } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return { sha256: sha(content), bytes: Buffer.byteLength(content) };
}

/** A small fake "todo app" screenshot, so thumbnails look like something. */
function fakeScreenshot(w: number, h: number, items: number, variant: number, broken: boolean): Buffer {
  const png = new PNG({ width: w, height: h });
  const fill = (x0: number, y0: number, x1: number, y1: number, [r, g, b]: number[]) => {
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
        const i = (y * w + x) * 4;
        png.data[i] = r;
        png.data[i + 1] = g;
        png.data[i + 2] = b;
        png.data[i + 3] = 255;
      }
  };
  fill(0, 0, w, h, [245, 246, 248]);
  const cx = Math.round(w * 0.2);
  const cw = Math.round(w * 0.6);
  fill(cx, 40, cx + 140, 70, [30, 34, 40]); // h1
  fill(cx, 90, cx + cw, 130, [255, 255, 255]); // input card
  fill(cx + cw - 80, 98, cx + cw - 10, 122, broken ? [200, 60, 50] : [47, 95, 208]); // add button
  for (let i = 0; i < items; i++) {
    const y = 150 + i * 44;
    fill(cx, y, cx + cw, y + 38, [255, 255, 255]);
    fill(cx + 12, y + 11, cx + 28, y + 27, i % 3 === variant % 3 ? [26, 127, 67] : [200, 205, 212]);
    fill(cx + 40, y + 15, cx + 40 + 80 + ((i * 37 + variant * 13) % 160), y + 23, [90, 98, 110]);
  }
  fill(cx, 150 + items * 44 + 10, cx + 120, 150 + items * 44 + 22, [140, 146, 156]); // counter
  return PNG.sync.write(png);
}

const CHECK_IDS: [string, CheckResult['category']][] = [
  ['startup.build', 'startup'],
  ['startup.ready', 'startup'],
  ['api.list.empty', 'backend'],
  ['api.create.valid', 'backend'],
  ['api.create.validation', 'backend'],
  ['api.patch.toggle', 'backend'],
  ['api.delete', 'backend'],
  ['api.errors.not_found', 'backend'],
  ['backend.persistence.restart', 'backend'],
  ['ui.add', 'functional'],
  ['ui.toggle', 'functional'],
  ['ui.edit.save', 'functional'],
  ['ui.edit.cancel', 'functional'],
  ['ui.filters', 'functional'],
  ['ui.counter', 'functional'],
  ['ui.error.alert', 'functional'],
  ['browser.add-and-complete', 'browser'],
  ['browser.persistence', 'browser'],
  ['browser.empty-state', 'browser'],
  ['visual.desktop', 'visual'],
  ['visual.mobile', 'visual'],
];

const HYPOTHESES: [string, string, Record<string, string>][] = [
  ['Trim the system prompt: drop generic coding advice the model already follows.', 'system-prompt.md: removed 3 generic sections (-410 words)', { 'system-prompt.md': 'trim' }],
  ['Truncate run_command output to 4k chars to cut npm/build log noise.', 'tools.json: run_command.maxOutputChars 4000, outputMode truncate', { 'tools.json': 'truncate' }],
  ['Enable prompt caching for the stable system prompt and tool definitions.', 'config.json: promptCaching true', { 'config.json': 'cache' }],
  ['Inline the API contract so the agent stops reading it with read_file.', 'config.json: inlineSpecFiles += api-contract.yaml', { 'config.json': 'inline' }],
  ['Add a skill with the exact UI accessibility contract checklist.', 'skills/ui-contract.md: new (38 lines)', { 'skills/ui-contract.md': 'new' }],
  ['Drop old tool results after 6 to keep context small.', 'config.json: context.strategy drop-old-tool-results, keep 6', { 'config.json': 'context' }],
  ['Disable view_image; rely on design-tokens.md for visuals.', 'tools.json: view_image disabled', { 'tools.json': 'noimage' }],
  ['Ask for whole-file writes instead of many small edits.', 'system-prompt.md: + "prefer write_file for new files"', { 'system-prompt.md': 'write' }],
  ['Lower maxOutputTokensPerCall to 4096 to discourage rambling.', 'config.json: maxOutputTokensPerCall 4096', { 'config.json': 'maxout' }],
  ['Combine the build+test loop into one run_command recipe skill.', 'skills/build-loop.md: new (12 lines)', { 'skills/build-loop.md': 'new' }],
  ['Summarize long tool outputs with an extra call (counted as coding tokens).', 'tools.json: run_command.outputMode summarize', { 'tools.json': 'summarize' }],
  ['Remove the design image from the first message; file-only delivery.', 'config.json: designDelivery file-only', { 'config.json': 'fileonly' }],
];

const BASE_FILES: Record<string, string> = {
  'config.json': JSON.stringify(
    {
      provider: 'mock',
      model: 'mock-model',
      maxOutputTokensPerCall: 8192,
      promptCaching: false,
      designDelivery: 'inline-image',
      inlineSpecFiles: ['requirements.md'],
      context: { strategy: 'none' },
      limits: { maxTotalTokens: 2000000, maxModelCalls: 200, maxRuntimeSec: 3600 },
    },
    null,
    2,
  ),
  'system-prompt.md': `# Role\nYou are a senior full-stack engineer.\n\n# Task\nBuild the todo app described in /spec.\n\n# General advice\nWrite clean code.\nTest your work.\nKeep functions small.\n\n# Workflow\n1. Read the spec.\n2. Implement the backend.\n3. Implement the frontend.\n4. Run the build.\n`,
  'tools.json': JSON.stringify(
    [
      { name: 'read_file', enabled: true },
      { name: 'write_file', enabled: true },
      { name: 'edit_file', enabled: true },
      { name: 'list_dir', enabled: true },
      { name: 'run_command', enabled: true, timeoutSec: 120 },
      { name: 'view_image', enabled: true },
    ],
    null,
    2,
  ),
};

function mutate(files: Record<string, string>, change: Record<string, string>): Record<string, string> {
  const out = { ...files };
  for (const [file, kind] of Object.entries(change)) {
    if (file === 'system-prompt.md' && kind === 'trim') out[file] = out[file].replace(/# General advice[\s\S]*?\n\n/, '');
    else if (file === 'system-prompt.md') out[file] = out[file] + '\nPrefer write_file for new files instead of many edit_file calls.\n';
    else if (file.startsWith('skills/')) out[file] = `# ${file.slice(7, -3)}\n\n- Checklist item one\n- Checklist item two\n- Run \`npm run build && npm test\` once at the end\n`;
    else if (file === 'tools.json') {
      const t = JSON.parse(out[file]);
      const rc = t.find((x: { name: string }) => x.name === 'run_command');
      if (kind === 'truncate') Object.assign(rc, { maxOutputChars: 4000, outputMode: 'truncate' });
      if (kind === 'summarize') Object.assign(rc, { outputMode: 'summarize' });
      if (kind === 'noimage') t.find((x: { name: string }) => x.name === 'view_image').enabled = false;
      out[file] = JSON.stringify(t, null, 2);
    } else if (file === 'config.json') {
      const c = JSON.parse(out[file]);
      if (kind === 'cache') c.promptCaching = true;
      if (kind === 'inline') c.inlineSpecFiles.push('api-contract.yaml');
      if (kind === 'context') c.context = { strategy: 'drop-old-tool-results', keepRecentToolResults: 6 };
      if (kind === 'maxout') c.maxOutputTokensPerCall = 4096;
      if (kind === 'fileonly') c.designDelivery = 'file-only';
      out[file] = JSON.stringify(c, null, 2);
    }
  }
  return out;
}

function totals(r: () => number, base: number, cache: boolean): TokenTotals {
  const total = Math.round(base * (0.85 + r() * 0.3));
  const cacheRead = cache ? Math.round(total * 0.55) : 0;
  const cacheWrite = cache ? Math.round(total * 0.06) : 0;
  const output = Math.round((total - cacheRead - cacheWrite) * 0.18);
  const input = total - cacheRead - cacheWrite - output;
  const costUsd = (input * 3 + output * 15 + cacheRead * 0.3 + cacheWrite * 3.75) / 1e6;
  return {
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: Math.round(output * 0.2),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens: total,
    costUsd,
    modelCalls: 20 + Math.round(r() * 40),
    anyEstimated: false,
  };
}

function traceLines(r: () => number, turns: number, failing: boolean): string {
  const tools = ['read_file', 'list_dir', 'write_file', 'edit_file', 'run_command'];
  const out: string[] = [];
  const t0 = Date.parse('2026-11-13T22:00:00Z');
  for (let t = 1; t <= turns; t++) {
    out.push(
      JSON.stringify({
        type: 'assistant',
        turn: t,
        ts: new Date(t0 + t * 9000).toISOString(),
        text: t === 1 ? '[MOCK] I will start by reading the spec and the starter project.' : `[MOCK] Step ${t}: continuing implementation.`,
        usage: { inputTokens: 1200 + Math.round(r() * 3000), outputTokens: 150 + Math.round(r() * 600) },
        stopReason: t === turns ? 'end_turn' : 'tool_use',
      }),
    );
    if (t === turns) break;
    const n = 1 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) {
      const tool = tools[Math.floor(r() * tools.length)];
      const isErr = failing && t === turns - 1 && k === 0;
      const input =
        tool === 'run_command'
          ? { command: r() > 0.5 ? 'npm run build' : 'npm test' }
          : { path: ['/workspace/backend/server.js', '/workspace/frontend/src/App.jsx', '/spec/requirements.md'][Math.floor(r() * 3)] };
      out.push(
        JSON.stringify({
          type: 'tool_call',
          turn: t,
          tool,
          input,
          output: isErr ? 'Error: Cannot find module "express-session"' : tool === 'run_command' ? '> vite build\n✓ 42 modules transformed.\n[MOCK OUTPUT]' : '[MOCK] ok',
          isError: isErr,
          durationMs: Math.round(r() * 4000),
        }),
      );
    }
  }
  return out.join('\n') + '\n';
}

export function seedDevDb(opts: SeedOptions): { experiments: number; runs: number } {
  const resolvedDb = path.resolve(opts.dbPath);
  if (path.basename(resolvedDb) === 'benchmark.db') throw new Error('Refusing to write fake data to benchmark.db');
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(resolvedDb + suffix, { force: true });
  fs.rmSync(opts.artifactsDir, { recursive: true, force: true });

  const db = openDb(resolvedDb, { experimentsJsonl: null });
  const r = rng(42);
  const root = opts.rootDir ?? repoRoot;
  const relToRepo = (p: string) => path.relative(root, p).split(path.sep).join('/');
  const nExp = opts.experiments ?? HYPOTHESES.length;
  const sessionId = 'dev-session-1';
  db.createSession({
    id: sessionId,
    isMock: true,
    budgets: { maxExperiments: 20, maxResearchCostUsd: 50, maxTokensPerCodingRun: null, maxRuntimePerExperimentSec: 3600, maxTotalDurationSec: 86400, verificationRuns: 3 },
  });

  const configsDir = path.join(opts.artifactsDir, 'configs');
  const writeConfig = (id: string, files: Record<string, string>, parentId: string | null, hypothesis: string | null) => {
    const dir = path.join(configsDir, id);
    for (const [f, c] of Object.entries(files)) writeFile(path.join(dir, f), c);
    db.insertConfig({ configId: id, hash: sha(JSON.stringify(files)), parentId, path: relToRepo(dir), hypothesis });
  };

  let clock = Date.parse('2026-11-13T22:00:00Z');
  const iso = () => new Date(clock).toISOString();
  let runCount = 0;

  // Outcome plan per experiment index (0 = baseline).
  type Plan = { outcome: 'baseline' | 'promoted' | 'not_better' | 'failed_quick_run' | 'failed_verification' | 'error' | 'running'; factor: number };
  const plan: Plan[] = [
    { outcome: 'baseline', factor: 1 },
    { outcome: 'promoted', factor: 0.86 },
    { outcome: 'not_better', factor: 0.9 },
    { outcome: 'promoted', factor: 0.62 },
    { outcome: 'failed_quick_run', factor: 0.55 },
    { outcome: 'promoted', factor: 0.57 },
    { outcome: 'failed_verification', factor: 0.48 },
    { outcome: 'not_better', factor: 0.6 },
    { outcome: 'failed_quick_run', factor: 0.4 },
    { outcome: 'error', factor: 0.7 },
    { outcome: 'promoted', factor: 0.51 },
    { outcome: 'not_better', factor: 0.66 },
    { outcome: 'running', factor: 0.47 },
  ];

  let parentId = 'baseline';
  let parentFiles = BASE_FILES;
  writeConfig('baseline', BASE_FILES, null, null);
  const BASE_TOKENS = 1_400_000;

  for (let i = 0; i <= nExp && i < plan.length; i++) {
    const p = plan[i];
    const isBaseline = i === 0;
    const configId = isBaseline ? 'baseline' : `experiments/${String(i).padStart(3, '0')}`;
    const [hyp, changeSummary, change] = isBaseline ? ['Baseline configuration (reference point).', 'none', {}] : HYPOTHESES[(i - 1) % HYPOTHESES.length];
    const files = isBaseline ? BASE_FILES : mutate(parentFiles, change);
    if (!isBaseline) writeConfig(configId, files, parentId, hyp);

    clock += 20 * 60_000;
    const exp = db.insertExperiment({
      sessionId,
      kind: isBaseline ? 'baseline' : 'candidate',
      parentConfigId: isBaseline ? null : parentId,
      candidateConfigId: configId,
      hypothesis: `[MOCK] ${hyp}`,
      changeSummary,
      changes: changeSummary,
      provider: 'mock',
      model: 'mock-model',
      status: 'running',
      isMock: true,
      createdAt: iso(),
    });

    // Research-agent usage for proposing this experiment.
    if (!isBaseline) {
      const rec: UsageRecord = {
        id: `dev-research-${i}`,
        role: 'research',
        experimentId: exp.id,
        provider: 'mock',
        model: 'mock-model',
        timestamp: iso(),
        inputTokens: 18_000 + Math.round(r() * 8000),
        outputTokens: 1200 + Math.round(r() * 800),
        reasoningTokens: 0,
        reasoningIncludedInOutput: true,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        costEstimated: true,
        usageEstimated: false,
        purpose: 'propose-experiment',
        raw: { mock: true },
      };
      rec.totalTokens = rec.inputTokens + rec.outputTokens;
      rec.costUsd = (rec.inputTokens * 3 + rec.outputTokens * 15) / 1e6;
      db.insertUsageRecords([rec], { sessionId, experimentId: exp.id });
    }

    const quickFails = p.outcome === 'failed_quick_run';
    const nRuns = p.outcome === 'running' ? 2 : quickFails || p.outcome === 'error' ? 1 : 3;
    const runs: { tokens: number; passed: boolean; visual: number; durationMs: number; cost: number }[] = [];
    for (let k = 0; k < nRuns; k++) {
      const runId = `dev-${exp.id}-r${k + 1}`;
      const phase = k === 0 && !isBaseline ? 'quick' : 'verify';
      const runDir = path.join(opts.artifactsDir, 'runs', runId);
      const stillRunning = p.outcome === 'running' && k === nRuns - 1;
      const startedAt = iso();
      db.insertRunStart({ runId, experimentId: exp.id, configId, seed: 1000 + k, phase, suite: 'dev', provider: 'mock', model: 'mock-model', startedAt, usedMockProvider: true });
      runCount++;
      if (stillRunning) break;

      const failing = quickFails || (p.outcome === 'failed_verification' && k === 2) || p.outcome === 'error';
      const usage = totals(r, BASE_TOKENS * p.factor, JSON.parse(files['config.json']).promptCaching);
      const durationMs = Math.round((9 + r() * 10) * 60_000);
      clock += durationMs;
      const finishedAt = iso();

      const tracePath = path.join(runDir, 'trace.jsonl');
      const traceMeta = writeFile(tracePath, traceLines(r, 6 + Math.floor(r() * 6), failing));
      const usagePath = path.join(runDir, 'usage.jsonl');
      const usageMeta = writeFile(usagePath, JSON.stringify({ mock: true, ...usage }) + '\n');

      const coding: CodingRunResult = {
        runId,
        experimentId: exp.id,
        configId,
        seed: 1000 + k,
        status: p.outcome === 'error' ? 'agent_error' : 'completed',
        failureReason: p.outcome === 'error' ? '[MOCK] Agent exceeded maxModelCalls (200) while retrying a failing build.' : undefined,
        startedAt,
        finishedAt,
        durationMs,
        imageId: 'sha256:0f3c9d2b7e4a1c8f5d6e7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d',
        starterHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        configHash: sha(JSON.stringify(files)).slice(0, 16),
        usage,
        toolCalls: 30 + Math.round(r() * 60),
        artifacts: { appSnapshotDir: relToRepo(path.join(runDir, 'app')), traceFile: relToRepo(tracePath), usageFile: relToRepo(usagePath), configSnapshotDir: relToRepo(path.join(runDir, 'config')) },
        usedMockProvider: true,
      };

      let evaluation: EvaluationResult | null = null;
      let passed = false;
      let visual = 0;
      if (p.outcome !== 'error') {
        visual = failing ? 88 + r() * 6 : 95.5 + r() * 4;
        const shotsDir = path.join(runDir, 'eval', 'dev', 'screenshots');
        const shots = ['desktop.png', 'mobile.png', 'after-add.png', 'filter-completed.png'].map((name, si) => {
          const file = path.join(shotsDir, name);
          const isMobile = name === 'mobile.png';
          writeFile(file, fakeScreenshot(isMobile ? 260 : 640, isMobile ? 520 : 400, 3 + si, i + si, failing && si === 2));
          return relToRepo(file);
        });
        const failIds = failing ? new Set(['ui.edit.save', 'browser.persistence']) : new Set<string>();
        const checks: CheckResult[] = CHECK_IDS.map(([id, category]) => {
          let outcome: CheckResult['outcome'] = failIds.has(id) ? 'fail' : 'pass';
          if (id === 'visual.desktop' && failing) outcome = 'fail';
          if (id === 'browser.empty-state' && failing && r() > 0.5) outcome = 'error';
          return {
            id,
            category,
            mandatory: category !== 'visual' || id === 'visual.desktop',
            outcome,
            message:
              outcome === 'pass'
                ? undefined
                : outcome === 'error'
                  ? '[MOCK] Browser agent timed out after 3 attempts (evaluator infrastructure).'
                  : id === 'ui.edit.save'
                    ? '[MOCK] Pressing Enter in "Edit title" did not save; title unchanged after reload.'
                    : id === 'browser.persistence'
                      ? '[MOCK] Todo disappeared after page reload; GET /api/todos returned [].'
                      : `[MOCK] Visual score ${visual.toFixed(1)} below threshold 95.`,
            evidence: outcome === 'pass' ? [] : [shots[2]],
            attempts: outcome === 'error' ? 3 : 1,
          };
        });
        passed = !failing;
        const reportPath = path.join(runDir, 'eval', 'dev', 'report.json');
        evaluation = {
          runId,
          suite: 'dev',
          seed: 1000 + k,
          startedAt: finishedAt,
          finishedAt: new Date(clock + 4 * 60_000).toISOString(),
          appStarted: true,
          checks,
          visualScore: Number(visual.toFixed(1)),
          visualThreshold: 95,
          passed,
          evaluatorFailure: false,
          failureSummary: failing ? '[MOCK] 2 mandatory checks failed: ui.edit.save, browser.persistence' : undefined,
          evaluatorUsage: { inputTokens: 60_000, outputTokens: 4000, reasoningTokens: 0, cacheReadTokens: 30_000, cacheWriteTokens: 5000, totalTokens: 99_000, costUsd: 0.27, modelCalls: 18, anyEstimated: false },
          reportFile: relToRepo(reportPath),
        };
        const reportMeta = writeFile(reportPath, JSON.stringify(evaluation, null, 2));
        clock += 4 * 60_000;
        db.finishRun(runId, coding, passed);
        db.insertEvaluation(evaluation);
        db.insertArtifact({ runId, experimentId: exp.id, kind: 'eval-report', path: relToRepo(reportPath), ...reportMeta });
        for (const s of shots) db.insertArtifact({ runId, experimentId: exp.id, kind: 'screenshot', path: s, ...{ sha256: sha(fs.readFileSync(path.join(root, s))), bytes: fs.statSync(path.join(root, s)).size } });
      } else {
        db.finishRun(runId, coding, false);
      }
      db.insertArtifact({ runId, experimentId: exp.id, kind: 'trace', path: relToRepo(tracePath), ...traceMeta });
      db.insertArtifact({ runId, experimentId: exp.id, kind: 'usage', path: relToRepo(usagePath), ...usageMeta });
      runs.push({ tokens: usage.totalTokens, passed, visual, durationMs, cost: usage.costUsd });
      if (quickFails) break;
    }

    if (p.outcome === 'running') {
      db.updateExperiment(exp.id, { status: 'verifying', quickPassed: true });
      continue;
    }
    const tokens = runs.map((x) => x.tokens).sort((a, b) => a - b);
    const med = tokens.length % 2 ? tokens[(tokens.length - 1) / 2] : (tokens[tokens.length / 2 - 1] + tokens[tokens.length / 2]) / 2;
    const passes = runs.filter((x) => x.passed).length;
    const meanT = tokens.reduce((a, b) => a + b, 0) / Math.max(tokens.length, 1);
    const summary: StoredSummary = {
      configId,
      runs: runs.length,
      passes,
      passRate: runs.length ? passes / runs.length : 0,
      medianTokens: med || 0,
      meanTokens: meanT,
      tokenVariance: tokens.reduce((a, b) => a + (b - meanT) ** 2, 0) / Math.max(tokens.length, 1),
      medianVisualScore: runs.map((x) => x.visual).sort((a, b) => a - b)[Math.floor(runs.length / 2)] ?? 0,
      totalCostUsd: runs.reduce((a, b) => a + b.cost, 0),
      medianDurationMs: runs.map((x) => x.durationMs).sort((a, b) => a - b)[Math.floor(runs.length / 2)] ?? 0,
      meetsQualityRequirements: runs.length > 1 && passes === runs.length,
      usedMockProvider: true,
      phase: runs.length > 1 ? 'verify' : 'quick',
    };
    const failed = p.outcome === 'failed_quick_run' || p.outcome === 'failed_verification' || p.outcome === 'error';
    db.updateExperiment(exp.id, {
      status: p.outcome === 'error' ? 'failed' : failed ? 'rejected' : 'completed',
      outcome: p.outcome,
      quickPassed: runs[0]?.passed ?? false,
      summary,
      error: p.outcome === 'error' ? '[MOCK] Coding agent errored: exceeded maxModelCalls.' : null,
      notes: p.outcome === 'promoted' ? '[MOCK] Would be promoted, but mock results are never eligible as best.' : null,
    });
    if (p.outcome === 'promoted') {
      parentId = configId;
      parentFiles = files;
    }
  }
  const n = db.listExperiments().length;
  db.close();
  return { experiments: n, runs: runCount };
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dbArg = process.argv.indexOf('--db');
  const dbPath = dbArg > 0 ? process.argv[dbArg + 1] : path.join(repoRoot, 'results', 'dev-dashboard.db');
  const res = seedDevDb({ dbPath, artifactsDir: path.join(repoRoot, 'results', 'dev-dashboard') });
  console.log(`[dev-seed] Wrote ${res.experiments} fake [MOCK] experiments / ${res.runs} runs to ${path.relative(repoRoot, path.resolve(dbPath))}`);
  console.log(`[dev-seed] Artifacts: results/dev-dashboard/. Start: npm run dashboard -- --db ${path.relative(repoRoot, path.resolve(dbPath))}`);
}
