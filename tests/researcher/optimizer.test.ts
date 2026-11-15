import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyProposal, hashFiles, OptimizerError, readConfigFiles } from '../../researcher/optimizer.js';
import { diffFileSets, diffLines } from '../../researcher/diff.js';
import { validateProposal } from '../../researcher/whitelist.js';
import { openDb, type Db } from '../../storage/db.js';
import { makeConfigsRoot, makeTmp, rmTmp } from './helpers.js';

const WL = { allowModelChange: false };

describe('optimizer', () => {
  let dir: string;
  let configs: string;
  let db: Db;
  beforeEach(() => {
    dir = makeTmp();
    configs = makeConfigsRoot(dir);
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
    rmTmp(dir);
  });

  it('creates a new read-only candidate dir with meta.json, diff and DB row', () => {
    const r = applyProposal({
      parentConfigId: 'baseline',
      proposal: {
        hypothesis: 'shorter prompt saves tokens',
        changeSummary: 'trimmed prompt; added a skill; lowered effort',
        files: { 'system-prompt.md': 'You are a coding agent.\nBuild the todo app fast.\n', 'skills/plan.md': '# Plan once\n', 'config.json': { effort: 'medium', context: { strategy: 'drop-old-tool-results', compactAtTokens: 80000, keepRecentToolResults: 4 } } },
      },
      whitelist: WL,
      configsRoot: configs,
      db,
    });
    expect(r.configId).toBe('experiments/001');
    expect(existsSync(join(r.dir, 'meta.json'))).toBe(true);
    const meta = JSON.parse(readFileSync(join(r.dir, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({ id: 'experiments/001', parentId: 'baseline', hypothesis: 'shorter prompt saves tokens', hash: r.hash });
    expect(meta.changes).toContain('+Build the todo app fast.');
    expect(meta.changes).toContain('-Be efficient.');
    expect(meta.changes).toContain('+++ b/skills/plan.md');
    // read-only
    expect(statSync(join(r.dir, 'system-prompt.md')).mode & 0o222).toBe(0);
    expect(() => writeFileSync(join(r.dir, 'system-prompt.md'), 'x')).toThrow();
    // merged config: approved fields applied, limits/provider untouched, id/parentId set
    const cfg = JSON.parse(readFileSync(join(r.dir, 'config.json'), 'utf8'));
    expect(cfg.effort).toBe('medium');
    expect(cfg.context).toEqual({ strategy: 'drop-old-tool-results', compactAtTokens: 80000, keepRecentToolResults: 4 });
    expect(cfg.limits.maxTotalTokens).toBe(2000000);
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.id).toBe('experiments/001');
    expect(cfg.parentId).toBe('baseline');
    // untouched files copied
    expect(readFileSync(join(r.dir, 'skills', 'api.md'), 'utf8')).toContain('API skill');
    expect(db.getConfig('experiments/001')).toMatchObject({ hash: r.hash, parentId: 'baseline' });
    expect(hashFiles(readConfigFiles('experiments/001', configs))).toBe(r.hash);
  });

  it('allocates unique ids that are never reused, and supports skill deletion', () => {
    const p = (t: string) => ({ hypothesis: 'hypothesis ' + t, changeSummary: 'change', files: { 'system-prompt.md': t } });
    const a = applyProposal({ parentConfigId: 'baseline', proposal: p('A'), whitelist: WL, configsRoot: configs, db });
    const b = applyProposal({ parentConfigId: a.configId, proposal: { ...p('B'), files: { 'skills/api.md': null } }, whitelist: WL, configsRoot: configs, db });
    expect([a.configId, b.configId]).toEqual(['experiments/001', 'experiments/002']);
    expect(existsSync(join(b.dir, 'skills', 'api.md'))).toBe(false);
    expect(b.diff).toContain('+++ /dev/null');
    // a rejected (no-op) proposal still burns its id
    expect(() => applyProposal({ parentConfigId: b.configId, proposal: p('A'), whitelist: WL, configsRoot: configs, db })).toThrow(/no substantive change/);
    const c = applyProposal({ parentConfigId: 'baseline', proposal: p('C'), whitelist: WL, configsRoot: configs, db });
    expect(c.configId).toBe('experiments/004');
  });

  it('rejects paths outside the whitelist', () => {
    for (const bad of ['../evaluator/score.ts', 'benchmark/spec/requirements.md', 'skills/../../x.md', '/etc/passwd', 'skills/sub/dir.md', 'meta.json', 'limits.json']) {
      expect(() =>
        applyProposal({ parentConfigId: 'baseline', proposal: { hypothesis: 'bad path test', changeSummary: 'x y z', files: { [bad]: 'x' } as never }, whitelist: WL, configsRoot: configs, db }),
      ).toThrow(OptimizerError);
    }
    expect(existsSync(join(configs, 'experiments', '001'))).toBe(false);
  });

  it('rejects forbidden config.json fields', () => {
    for (const patch of [{ limits: { maxTotalTokens: 1 } }, { provider: 'mock' }, { model: 'claude-opus-5-5' }, { id: 'x' }, { context: { evil: 1 } }, { designDelivery: 'nope' }]) {
      expect(() =>
        applyProposal({ parentConfigId: 'baseline', proposal: { hypothesis: 'forbidden field', changeSummary: 'x y z', files: { 'config.json': patch } }, whitelist: WL, configsRoot: configs, db }),
      ).toThrow(/not approved|not allowed|must be/);
    }
    // model allowed only when enabled (and in the allow list)
    const ok = applyProposal({
      parentConfigId: 'baseline',
      proposal: { hypothesis: 'cheaper model', changeSummary: 'model swap', files: { 'config.json': { model: 'claude-haiku-5-5' } } },
      whitelist: { allowModelChange: true, allowedModels: ['claude-haiku-5-5'] },
      configsRoot: configs,
      db,
    });
    expect(JSON.parse(readFileSync(join(ok.dir, 'config.json'), 'utf8')).model).toBe('claude-haiku-5-5');
  });

  it('validates tools.json content', () => {
    const v = (tools: unknown) => validateProposal({ hypothesis: 'tools change', changeSummary: 'tools', files: { 'tools.json': JSON.stringify(tools) } }, WL);
    expect(v([{ name: 'read_file', enabled: true, maxOutputChars: 4000, outputMode: 'truncate' }]).ok).toBe(true);
    expect(v([{ name: 'shell_exec', enabled: true }]).ok).toBe(false);
    expect(v([{ name: 'read_file', enabled: true, network: true }]).ok).toBe(false);
    expect(v([{ name: 'read_file', enabled: false }]).ok).toBe(false);
    expect(validateProposal({ hypothesis: 'tools change', changeSummary: 'tools', files: { 'tools.json': '{not json' } }, WL).ok).toBe(false);
  });
});

describe('diff', () => {
  it('produces unified hunks with context', () => {
    const a = 'one\ntwo\nthree\nfour\nfive\nsix\n';
    const b = 'one\ntwo\nTHREE\nfour\nfive\nsix\nseven\n';
    const d = diffLines(a, b, 'f.md');
    expect(d).toContain('--- a/f.md');
    expect(d).toContain('-three');
    expect(d).toContain('+THREE');
    expect(d).toContain('+seven');
    expect(d).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(diffLines(a, a, 'f.md')).toBe('');
  });
  it('diffs file sets including additions and deletions', () => {
    const d = diffFileSets({ 'a.md': 'x\n', 'b.md': 'y\n' }, { 'a.md': 'x\n', 'c.md': 'z\n' });
    expect(d).toContain('--- a/b.md\n+++ /dev/null');
    expect(d).toContain('--- /dev/null\n+++ b/c.md');
    expect(d).not.toContain('a.md');
  });
});
