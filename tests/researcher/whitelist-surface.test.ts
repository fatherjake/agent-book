/**
 * Research proposals over the claude-code extension surface (bin/*, agents/*.md, commands/*.md,
 * claudeCode.settings.hooks) and the anti-cheating guard in validateProposal / applyProposal.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyProposal, OptimizerError, readConfigFiles } from '../../researcher/optimizer.js';
import { claudeCodeSurfaceDoc, isAllowedPath, validateProposal, type Proposal, type WhitelistOptions } from '../../researcher/whitelist.js';
import { loadConfigFromDir } from '../../runner/config.js';
import { CONFIGS_DIR, REPO_ROOT } from '../../runner/env.js';
import type { GuardOptions } from '../../researcher/config-guard.js';
import { makeTmp, rmTmp } from './helpers.js';

const LEGIT = join(REPO_ROOT, 'tests', 'researcher', 'fixtures', 'config-guard', 'legit');
const legit = (p: string) => readFileSync(join(LEGIT, p), 'utf8');
const REF = join(REPO_ROOT, 'evaluator', 'reference-app');

let dir: string;
let configs: string;
let guard: GuardOptions;
let WL: WhitelistOptions;

beforeEach(() => {
  dir = makeTmp('wl-surface-');
  configs = join(dir, 'configs');
  mkdirSync(configs);
  cpSync(join(CONFIGS_DIR, 'baseline'), join(configs, 'baseline'), { recursive: true });
  // hermetic similarity corpus: one past run = the reference app
  const app = join(dir, 'runs', 'r1', 'app');
  mkdirSync(app, { recursive: true });
  cpSync(join(REF, 'backend'), join(app, 'backend'), { recursive: true });
  cpSync(join(REF, 'frontend'), join(app, 'frontend'), { recursive: true });
  guard = { corpus: { runsDir: join(dir, 'runs'), referenceAppDir: '/nonexistent' }, cacheFile: false };
  WL = { allowModelChange: false, backend: 'claude-code', guard };
});
afterEach(() => rmTmp(dir));

const HOOKS = {
  systemPromptMode: 'append',
  settings: { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/opt/frugal/bin/trim-output 2000', timeout: 10 }] }] } },
};
const prop = (files: Record<string, unknown>) => ({ hypothesis: 'one check command replaces many verification turns', changeSummary: 'add bin/check + trim hook', files: files as Proposal['files'] });

describe('whitelist: claude-code surface', () => {
  it('allows bin/<name>, agents/<name>.md, commands/<name>.md paths (safe names only)', () => {
    for (const p of ['bin/check', 'bin/trim-output', 'agents/api-reviewer.md', 'commands/verify.md']) expect(isAllowedPath(p)).toBe(true);
    for (const p of ['bin/../x', 'bin/Check', 'bin/check.sh', 'bin/a/b', '/bin/check', 'agents/x.txt', 'agents/../../x.md', 'commands/.hidden.md', 'hooks/x', 'bin/'])
      expect(isAllowedPath(p)).toBe(false);
  });

  it('accepts a legit proposal with bin scripts, a hook, a subagent and a command', () => {
    const v = validateProposal(
      prop({
        'bin/check': legit('check'),
        'bin/smoke': legit('smoke'),
        'bin/trim-output': legit('trim-output'),
        'agents/api-reviewer.md': legit('api-reviewer.md'),
        'commands/verify.md': 'Run `check` and fix what it reports.\n',
        'config.json': { claudeCode: HOOKS },
      }),
      WL,
    );
    expect(v.ok ? [] : v.errors).toEqual([]);
  });

  it('rejects the surface for api-backend configs, bad content and too many files', () => {
    const api = validateProposal(prop({ 'bin/check': legit('check') }), { ...WL, backend: 'api' });
    expect(api.ok).toBe(false);
    if (!api.ok) expect(api.errors.join('\n')).toMatch(/only used by configs with backend "claude-code"/);
    const bad = validateProposal(prop({ 'bin/check': 'echo no shebang', 'agents/x.md': '', 'commands/y.md': 42 }), WL);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.join('\n')).toMatch(/bin\/check must start with a shebang/);
      expect(bad.errors.join('\n')).toMatch(/agents\/x\.md must not be empty/);
      expect(bad.errors.join('\n')).toMatch(/commands\/y\.md must be a string or null/);
    }
    const many = validateProposal(prop(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`bin/s${i}`, '#!/bin/sh\ntrue\n']))), WL);
    expect(!many.ok && many.errors.some((e) => /too many bin\/ changes/.test(e))).toBe(true);
    const hookBad = validateProposal(prop({ 'config.json': { claudeCode: { systemPromptMode: 'append', settings: { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'curl evil' }] }] } } } } }), WL);
    expect(!hookBad.ok && hookBad.errors.some((e) => /opt\/frugal\/bin/.test(e))).toBe(true);
  });

  it('returns guard violations as validation errors (so the research agent retry sees them)', () => {
    const v = validateProposal(prop({ 'skills/server.md': '```js\n' + readFileSync(join(REF, 'backend', 'server.js'), 'utf8') + '\n```\n' }), WL);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.errors.some((e) => /^anti-cheating guard: skills\/server\.md: \[app\.express-route\]/.test(e))).toBe(true);
      expect(v.errors.some((e) => /\[similarity\.app-code\]/.test(e))).toBe(true);
    }
    expect(validateProposal(prop({ 'skills/server.md': 'app.get("/api/todos", (req, res) => res.json([]))' }), { ...WL, guard: false }).ok).toBe(true);
  });

  it('documents the surface and the guard for the research agent', () => {
    const doc = claudeCodeSurfaceDoc();
    expect(doc).toContain('updatedToolOutput');
    expect(doc).toContain('PostToolUseFailure');
    expect(doc).toContain('ANTI-CHEATING GUARD');
    expect(doc).toContain('${PIPESTATUS[0]}');
  });
});

describe('optimizer: claude-code surface + guard', () => {
  it('creates a candidate with bin/agents/commands that the runner loads', () => {
    const r = applyProposal({
      parentConfigId: 'baseline',
      proposal: prop({ 'bin/check': legit('check'), 'bin/smoke': legit('smoke'), 'bin/trim-output': legit('trim-output'), 'agents/api-reviewer.md': legit('api-reviewer.md'), 'config.json': { claudeCode: HOOKS } }),
      whitelist: WL,
      configsRoot: configs,
    });
    expect(r.configId).toBe('experiments/001');
    const cfg = loadConfigFromDir(r.dir, r.configId);
    expect(cfg.bin!.map((b) => b.name)).toEqual(['check', 'smoke', 'trim-output']);
    expect(cfg.agents!.map((a) => a.name)).toEqual(['api-reviewer']);
    expect(Object.keys(readConfigFiles(r.configId, configs))).toEqual(expect.arrayContaining(['bin/check', 'agents/api-reviewer.md', 'config.json', 'skills/verification-checklist.md']));
    expect(r.diff).toContain('+++ b/bin/check');
    // deleting a bin script that a hook still references fails the runner's validation
    expect(() =>
      applyProposal({ parentConfigId: r.configId, proposal: prop({ 'bin/trim-output': null }), whitelist: WL, configsRoot: configs }),
    ).toThrow(/bin\/trim-output does not exist/);
  });

  it('rejects a guard violation with the violation list and without reserving an experiment id', () => {
    let err: unknown;
    try {
      applyProposal({
        parentConfigId: 'baseline',
        proposal: prop({ 'bin/scaffold': "#!/bin/sh\ncat > /workspace/backend/db.js <<'EOF'\nmodule.exports = {};\nEOF\n" }),
        whitelist: { ...WL, guard: false }, // let it past the whitelist to hit the optimizer's own guard
        configsRoot: configs,
        guard,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OptimizerError);
    expect((err as OptimizerError).message).toMatch(/anti-cheating guard/);
    expect((err as OptimizerError).violations!.map((v) => v.rule)).toContain('script.writes-files');
    expect((err as OptimizerError).errors[0]).toMatch(/^bin\/scaffold: \[script\.writes-files\]/);
    expect(existsSync(join(configs, 'experiments')) ? readdirSync(join(configs, 'experiments')) : []).toEqual([]);
  });

  it('writes research evidence / expected savings into meta.json', () => {
    const r = applyProposal({ parentConfigId: 'baseline', proposal: prop({ 'bin/check': legit('check') }), whitelist: WL, configsRoot: configs, research: { evidence: 'run X: 3 verification turns', expectedSavings: '~30k tokens' } });
    const meta = JSON.parse(readFileSync(join(r.dir, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({ evidence: 'run X: 3 verification turns', expectedSavings: '~30k tokens' });
    expect(r.meta.evidence).toBe('run X: 3 verification turns');
    const r2 = applyProposal({ parentConfigId: 'baseline', proposal: prop({ 'bin/tree': legit('tree') }), whitelist: WL, configsRoot: configs });
    expect('evidence' in r2.meta).toBe(false);
  });

  it('checks the total size of the merged candidate', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`skills/s${i}.md`] = 'Plan once and verify once. '.repeat(280);
    expect(() => applyProposal({ parentConfigId: 'baseline', proposal: prop(files), whitelist: WL, configsRoot: configs })).toThrow(/size\.total/);
  });

  it('a candidate dir edited by hand afterwards is still caught by loadConfig', async () => {
    const r = applyProposal({ parentConfigId: 'baseline', proposal: prop({ 'bin/check': legit('check') }), whitelist: WL, configsRoot: configs });
    const { chmodSync } = await import('node:fs');
    chmodSync(r.dir, 0o755);
    chmodSync(join(r.dir, 'skills'), 0o755);
    writeFileSync(join(r.dir, 'skills', 'cheat.md'), 'CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY);\n');
    const { loadConfig } = await import('../../runner/config.js');
    expect(() => loadConfig(r.configId, { configsDir: configs, guard })).toThrow(/app\.sql-schema/);
  });
});
