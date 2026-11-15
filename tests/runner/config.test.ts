import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, canonicalJson, hashConfig, loadConfig, loadConfigFromDir, snapshotConfig } from '../../runner/config.js';
import { CONFIGS_DIR } from '../../runner/env.js';

function tempConfigs(): string {
  const root = mkdtempSync(join(tmpdir(), 'cfg-'));
  // The api-backend baseline, copied under the id 'baseline' (validation tests for the api loop).
  cpSync(join(CONFIGS_DIR, 'baseline-api'), join(root, 'baseline'), { recursive: true });
  editJson(join(root, 'baseline', 'config.json'), (j) => {
    j.id = 'baseline';
  });
  return root;
}
function editJson(path: string, fn: (j: any) => void) {
  const j = JSON.parse(readFileSync(path, 'utf8'));
  fn(j);
  writeFileSync(path, JSON.stringify(j));
}

describe('loadConfig', () => {
  it('loads the api baseline', () => {
    const cfg = loadConfig('baseline-api');
    expect(cfg).toMatchObject({ id: 'baseline-api', backend: 'api', provider: 'anthropic', model: 'claude-sonnet-5-5', promptCaching: true });
    expect(cfg.limits).toEqual({ maxTotalTokens: 3_000_000, maxModelCalls: 150, maxRuntimeSec: 2400 });
    expect(cfg.systemPrompt.length).toBeGreaterThan(200);
    expect(cfg.skills.length).toBeGreaterThanOrEqual(1);
    expect(cfg.tools.filter((t) => t.enabled).map((t) => t.name).sort()).toEqual(['edit_file', 'list_dir', 'read_file', 'run_command', 'view_image', 'write_file']);
  });

  it('loads nested ids like experiments/001', () => {
    const root = tempConfigs();
    mkdirSync(join(root, 'experiments'));
    cpSync(join(root, 'baseline'), join(root, 'experiments', '001'), { recursive: true });
    editJson(join(root, 'experiments', '001', 'config.json'), (j) => {
      j.id = 'experiments/001';
      j.parentId = 'baseline';
    });
    const cfg = loadConfig('experiments/001', { configsDir: root });
    expect(cfg.id).toBe('experiments/001');
    expect(cfg.parentId).toBe('baseline');
  });

  it('rejects bad ids and traversal', () => {
    expect(() => loadConfig('../etc')).toThrow(ConfigError);
    expect(() => loadConfig('a/../../b')).toThrow(ConfigError);
    expect(() => loadConfig('/abs')).toThrow(ConfigError);
  });

  const cases: [string, (j: any) => void, RegExp][] = [
    ['unknown field', (j) => (j.foo = 1), /unknown field 'foo'/],
    ['bad provider', (j) => (j.provider = 'openai'), /'provider' must be one of/],
    ['missing limits', (j) => delete j.limits, /'limits' must be an object/],
    ['bad limit', (j) => (j.limits.maxModelCalls = 0), /maxModelCalls/],
    ['unknown limit', (j) => (j.limits.maxCost = 1), /unknown field 'maxCost'/],
    ['bad designDelivery', (j) => (j.designDelivery = 'x'), /designDelivery/],
    ['bad context', (j) => (j.context = { strategy: 'summarize' }), /compactAtTokens' is required/],
    ['bad effort', (j) => (j.effort = 'extreme'), /'effort' must be one of/],
    ['id mismatch', (j) => (j.id = 'other'), /does not match/],
    ['traversal in inline files', (j) => (j.inlineSpecFiles = ['../evaluator/x']), /inlineSpecFiles/],
    ['bad promptCaching', (j) => (j.promptCaching = 'yes'), /promptCaching/],
  ];
  for (const [name, fn, re] of cases) {
    it(`rejects config.json: ${name}`, () => {
      const root = tempConfigs();
      editJson(join(root, 'baseline', 'config.json'), fn);
      expect(() => loadConfig('baseline', { configsDir: root })).toThrow(re);
    });
  }

  it('rejects bad tools.json', () => {
    const root = tempConfigs();
    const p = join(root, 'baseline', 'tools.json');
    writeFileSync(p, JSON.stringify([{ name: 'read_file', enabled: true }, { name: 'read_file', enabled: false }]));
    expect(() => loadConfig('baseline', { configsDir: root })).toThrow(/duplicate tool/);
    writeFileSync(p, JSON.stringify([{ name: 'shell', enabled: true }]));
    expect(() => loadConfig('baseline', { configsDir: root })).toThrow(/'name' must be one of/);
    writeFileSync(p, JSON.stringify([{ name: 'read_file', enabled: true, timeoutSec: 5 }]));
    expect(() => loadConfig('baseline', { configsDir: root })).toThrow(/only valid for run_command/);
    writeFileSync(p, JSON.stringify([{ name: 'read_file', enabled: false }]));
    expect(() => loadConfig('baseline', { configsDir: root })).toThrow(/at least one tool/);
    writeFileSync(p, '{not json');
    expect(() => loadConfig('baseline', { configsDir: root })).toThrow(/not valid JSON/);
  });

  it('rejects empty system prompt and non-md skills', () => {
    const root = tempConfigs();
    writeFileSync(join(root, 'baseline', 'skills', 'x.txt'), 'hi');
    expect(() => loadConfig('baseline', { configsDir: root })).toThrow(/only contain .md/);
    const root2 = tempConfigs();
    writeFileSync(join(root2, 'baseline', 'system-prompt.md'), '   ');
    expect(() => loadConfig('baseline', { configsDir: root2 })).toThrow(/empty/);
  });
});

describe('hashConfig / snapshotConfig', () => {
  it('is stable and ignores key order and metadata', () => {
    const a = loadConfig('baseline-api');
    const b = JSON.parse(canonicalJson(a));
    expect(hashConfig(a)).toBe(hashConfig(b));
    expect(hashConfig(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashConfig({ ...a, id: 'experiments/x', description: 'other', parentId: 'baseline' })).toBe(hashConfig(a));
  });
  it('changes when behaviour changes', () => {
    const a = loadConfig('baseline-api');
    expect(hashConfig({ ...a, systemPrompt: a.systemPrompt + ' ' })).not.toBe(hashConfig(a));
    expect(hashConfig({ ...a, tools: a.tools.map((t) => ({ ...t, maxOutputChars: 1234 })) })).not.toBe(hashConfig(a));
  });
  it('snapshot round-trips to an identical config', () => {
    const a = loadConfig('baseline-api');
    const dir = mkdtempSync(join(tmpdir(), 'snap-'));
    snapshotConfig(a, dir);
    const b = loadConfigFromDir(dir);
    expect(b).toEqual(a);
    expect(readFileSync(join(dir, 'hash.txt'), 'utf8').trim()).toBe(hashConfig(a));
  });
});

describe('claude-code backend config', () => {
  function ccConfigs(): string {
    const root = mkdtempSync(join(tmpdir(), 'cfgcc-'));
    cpSync(join(CONFIGS_DIR, 'baseline'), join(root, 'baseline'), { recursive: true });
    return root;
  }
  const load = (root: string) => loadConfig('baseline', { configsDir: root });

  it('loads the Claude Code baseline without tools.json', () => {
    const cfg = loadConfig('baseline');
    expect(cfg).toMatchObject({ backend: 'claude-code', provider: 'anthropic', model: 'claude-sonnet-5-5', claudeCode: { systemPromptMode: 'append' }, tools: [] });
    expect(cfg.skills.map((s) => s.name)).toEqual(['fullstack-checklist']);
  });

  it('accepts the full claudeCode block and loads CLAUDE.md', () => {
    const root = ccConfigs();
    editJson(join(root, 'baseline', 'config.json'), (j) => {
      j.effort = 'medium';
      j.claudeCode = {
        systemPromptMode: 'replace',
        tools: ['Bash', 'Read', 'Edit', 'Write'],
        disallowedTools: ['Bash(curl *)'],
        settings: { includeCoAuthoredBy: false, permissions: { deny: ['WebFetch'] } },
        env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '60', MAX_THINKING_TOKENS: '4000' },
        claudeMd: true,
      };
    });
    writeFileSync(join(root, 'baseline', 'CLAUDE.md'), '# Notes\n');
    const cfg = load(root);
    expect(cfg.claudeCode?.tools).toEqual(['Bash', 'Read', 'Edit', 'Write']);
    expect(cfg.claudeMdContent).toBe('# Notes\n');
    const dir = mkdtempSync(join(tmpdir(), 'snapcc-'));
    snapshotConfig(cfg, dir);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('# Notes\n');
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).claudeMdContent).toBeUndefined();
    expect(loadConfigFromDir(dir)).toEqual(cfg);
  });

  it('rejects env vars outside the allowlist and bad values', () => {
    for (const [env, re] of [
      [{ ANTHROPIC_BASE_URL: 'http://evil' }, /not allowed/],
      [{ CLAUDE_CODE_OAUTH_TOKEN: 'x' }, /not allowed/],
      [{ PATH: '/tmp' }, /not allowed/],
      [{ BASH_MAX_OUTPUT_LENGTH: 'a b; rm -rf /' }, /short string/],
      [{ BASH_MAX_OUTPUT_LENGTH: 5 }, /short string/],
    ] as const) {
      const root = ccConfigs();
      editJson(join(root, 'baseline', 'config.json'), (j) => (j.claudeCode = { systemPromptMode: 'append', env }));
      expect(() => load(root)).toThrow(re);
    }
  });

  it('rejects invalid claude-code fields and combinations', () => {
    const cases: [(j: any) => void, RegExp][] = [
      [(j) => (j.backend = 'other'), /'backend' must be/],
      [(j) => (j.claudeCode.systemPromptMode = 'prepend'), /systemPromptMode/],
      [(j) => (j.claudeCode.extra = 1), /unknown field 'extra'/],
      [(j) => (j.claudeCode.tools = ['bash; rm']), /tool names/],
      [(j) => (j.claudeCode.tools = ['Bash', 'Bash']), /unique/],
      [(j) => (j.claudeCode.settings = { env: { ANTHROPIC_BASE_URL: 'x' } }), /settings.env' is not allowed/],
      [(j) => (j.claudeCode.settings = { apiKeyHelper: 'cat key' }), /apiKeyHelper' is not allowed/],
      [(j) => (j.claudeCode.settings = { model: 'opus' }), /settings.model' is not allowed/],
      [(j) => (j.claudeCode.claudeMd = true), /CLAUDE.md is missing/],
      [(j) => (j.claudeCode.claudeMd = 'yes'), /must be a boolean/],
      [(j) => (j.provider = 'mock'), /requires provider 'anthropic'/],
      [(j) => (j.temperature = 0.5), /temperature/],
      [(j) => (j.context = { strategy: 'summarize', compactAtTokens: 5000 }), /context.strategy 'none'/],
      [
        (j) => {
          j.thinkingBudget = 1000;
          j.claudeCode.env = { MAX_THINKING_TOKENS: '2000' };
        },
        /either 'thinkingBudget'/,
      ],
    ];
    for (const [fn, re] of cases) {
      const root = ccConfigs();
      editJson(join(root, 'baseline', 'config.json'), fn);
      expect(() => load(root)).toThrow(re);
    }
    // claudeCode on an api config
    const root = tempConfigs();
    editJson(join(root, 'baseline', 'config.json'), (j) => (j.claudeCode = { systemPromptMode: 'append' }));
    expect(() => loadConfig('baseline', { configsDir: root })).toThrow(/only valid with backend 'claude-code'/);
  });

  it('validates tools.json if present but ignores it for claude-code', () => {
    const root = ccConfigs();
    writeFileSync(join(root, 'baseline', 'tools.json'), JSON.stringify([{ name: 'read_file', enabled: false }]));
    const a = load(root);
    expect(a.tools).toEqual([{ name: 'read_file', enabled: false }]);
    writeFileSync(join(root, 'baseline', 'tools.json'), '[{"name":"nope","enabled":true}]');
    expect(() => load(root)).toThrow(/'name' must be one of/);
  });

  it('hashConfig covers the new fields; api backend hashes like an absent field', () => {
    const cc = loadConfig('baseline');
    expect(hashConfig({ ...cc, claudeCode: { systemPromptMode: 'replace' } })).not.toBe(hashConfig(cc));
    expect(hashConfig({ ...cc, claudeCode: { systemPromptMode: 'append', env: { DISABLE_AUTO_COMPACT: '1' } } })).not.toBe(hashConfig(cc));
    expect(hashConfig({ ...cc, claudeMdContent: 'x', claudeCode: { systemPromptMode: 'append', claudeMd: true } })).not.toBe(hashConfig(cc));
    expect(hashConfig({ ...cc, tools: [{ name: 'read_file', enabled: true }] })).toBe(hashConfig(cc)); // ignored for claude-code
    expect(hashConfig({ ...cc, backend: 'api' })).not.toBe(hashConfig(cc));
    const api = loadConfig('baseline-api');
    const { backend: _b, ...noBackend } = api;
    expect(hashConfig(noBackend as typeof api)).toBe(hashConfig(api));
  });
});
