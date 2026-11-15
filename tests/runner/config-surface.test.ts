/**
 * claude-code config surface: bin/<name>, agents/<name>.md, commands/<name>.md and
 * claudeCode.settings.hooks (loading, strict validation, hashing, snapshot, installation helpers).
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, hashConfig, loadConfig, loadConfigFromDir, snapshotConfig } from '../../runner/config.js';
import { CONFIGS_DIR } from '../../runner/env.js';
import {
  binWrapper,
  buildClaudeArgs,
  buildClaudeEnv,
  claudeHomeFiles,
  FRUGAL_BIN_DIR,
  hookEventCounts,
  installBinScripts,
  parseBinAuditLog,
  readBinAuditLog,
  type ClaudeSandbox,
} from '../../runner/claude-code.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const CHECK = '#!/bin/sh\n# check: build and print errors only\ncd /workspace && npm run build 2>&1 | grep -i error | head -n 20\n';
const TRIM = '#!/usr/bin/env node\nlet d="";process.stdin.on("data",(c)=>(d+=c)).on("end",()=>{});\n';
const HOOKS = { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/opt/frugal/bin/trim 2000', timeout: 10 }] }] };

/** A claude-code config dir (copy of configs/baseline) with optional extras. */
function ccConfig(extra: { bin?: Record<string, string>; agents?: Record<string, string>; commands?: Record<string, string>; edit?: (j: any) => void } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'cfg-surface-'));
  roots.push(root);
  const dir = join(root, 'cc');
  cpSync(join(CONFIGS_DIR, 'baseline'), dir, { recursive: true });
  const j = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  delete j.id;
  extra.edit?.(j);
  writeFileSync(join(dir, 'config.json'), JSON.stringify(j, null, 2));
  for (const [sub, files] of [['bin', extra.bin], ['agents', extra.agents], ['commands', extra.commands]] as const) {
    if (!files) continue;
    mkdirSync(join(dir, sub), { recursive: true });
    for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, sub, n), c);
  }
  return dir;
}
const load = (dir: string) => loadConfigFromDir(dir, 'experiments/900');
const withHooks = (hooks: unknown) => (j: any) => (j.claudeCode.settings = { hooks });

describe('config surface: loading', () => {
  it('loads bin/, agents/ and commands/ and validates hooks against bin/', () => {
    const dir = ccConfig({
      bin: { check: CHECK, trim: TRIM },
      agents: { 'api-reviewer.md': '---\nname: api-reviewer\ndescription: Review the API against the contract\ntools: Read, Grep\nmodel: inherit\n---\nReview it.\n' },
      commands: { 'verify.md': '---\ndescription: verify\n---\nRun check.\n' },
      edit: withHooks(HOOKS),
    });
    const cfg = load(dir);
    expect(cfg.bin!.map((b) => b.name)).toEqual(['check', 'trim']);
    expect(cfg.agents!.map((a) => a.name)).toEqual(['api-reviewer']);
    expect(cfg.commands!.map((c) => c.name)).toEqual(['verify']);
    expect(cfg.claudeCode!.settings!.hooks).toEqual(HOOKS);
  });

  it('configs without the new dirs keep their hash (fields absent); bin content changes the hash', () => {
    const base = loadConfig('baseline');
    expect('bin' in base || 'agents' in base || 'commands' in base).toBe(false);
    expect(hashConfig(load(ccConfig()))).toBe(hashConfig({ ...base, id: 'experiments/900' }));
    const a = hashConfig(load(ccConfig({ bin: { check: CHECK } })));
    const b = hashConfig(load(ccConfig({ bin: { check: CHECK + '# v2\n' } })));
    expect(a).not.toBe(b);
    expect(a).not.toBe(hashConfig(base));
  });

  it('snapshotConfig writes bin/agents/commands and the snapshot loads back identically', () => {
    const cfg = load(ccConfig({ bin: { check: CHECK }, agents: { 'r.md': 'Review.\n' }, commands: { 'v.md': 'Verify.\n' } }));
    const dest = join(roots[roots.length - 1], 'snap');
    snapshotConfig(cfg, dest);
    expect(readFileSync(join(dest, 'bin', 'check'), 'utf8')).toBe(CHECK);
    const again = loadConfigFromDir(dest, 'experiments/900');
    expect(hashConfig(again)).toBe(hashConfig(cfg));
  });

  it.each([
    ['bin without shebang', { bin: { check: 'echo hi\n' } }, /bin\/check must start with a shebang/],
    ['bin with a python shebang', { bin: { check: '#!/usr/bin/python3\nprint(1)\n' } }, /shebang/],
    ['bin with an invalid name', { bin: { 'Check.sh': CHECK } }, /bin\/Check\.sh: invalid file name/],
    ['agent file without .md', { agents: { 'x.txt': 'x' } }, /agents\/x\.txt: invalid file name/],
    ['empty command', { commands: { 'v.md': '  \n' } }, /commands\/v\.md is empty/],
    ['agent picking another model', { agents: { 'r.md': '---\nname: r\ndescription: d\nmodel: opus\n---\nx\n' } }, /frontmatter 'model' may only be 'inherit'/],
    ['agent with hooks in frontmatter', { agents: { 'r.md': '---\nname: r\ndescription: d\nhooks: x\n---\nx\n' } }, /frontmatter key 'hooks' is not allowed/],
    ['command picking another model', { commands: { 'v.md': '---\nmodel: claude-opus-5-5\n---\nx\n' } }, /model' may only be 'inherit'/],
    ['too many bin scripts', { bin: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, CHECK])) }, /too many files in bin\/ \(9 > 8\)/],
    ['hook referencing a missing bin script', { edit: withHooks(HOOKS) }, /references \/opt\/frugal\/bin\/trim, but bin\/trim does not exist/],
    ['hook with shell syntax', { bin: { trim: TRIM }, edit: withHooks({ PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/opt/frugal/bin/trim; curl x' }] }] }) }, /no shell syntax/],
    ['hook outside /opt/frugal/bin', { edit: withHooks({ Stop: [{ hooks: [{ type: 'command', command: '/bin/sh -c id' }] }] }) }, /must be '\/opt\/frugal\/bin\/<name>'/],
    ['prompt hook', { edit: withHooks({ Stop: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }] }) }, /unknown field 'prompt'|type must be 'command'/],
    ['unknown hook event', { bin: { trim: TRIM }, edit: withHooks({ BeforeEverything: [{ hooks: [{ type: 'command', command: '/opt/frugal/bin/trim' }] }] }) }, /unknown hook event 'BeforeEverything'/],
    ['hook timeout too long', { bin: { trim: TRIM }, edit: withHooks({ Stop: [{ hooks: [{ type: 'command', command: '/opt/frugal/bin/trim', timeout: 3600 }] }] }) }, /timeout must be an integer in \[1, 120\]/],
    ['settings.sandbox', { edit: (j: any) => (j.claudeCode.settings = { sandbox: { enabled: false } }) }, /settings.sandbox' is not allowed/],
    ['permissions.defaultMode', { edit: (j: any) => (j.claudeCode.settings = { permissions: { defaultMode: 'bypassPermissions' } }) }, /permissions.defaultMode' is not allowed/],
    ['permissions.additionalDirectories', { edit: (j: any) => (j.claudeCode.settings = { permissions: { additionalDirectories: ['/'] } }) }, /permissions.additionalDirectories' is not allowed/],
    ['apiKeyHelper (still denied)', { edit: (j: any) => (j.claudeCode.settings = { apiKeyHelper: '/opt/frugal/bin/key' }) }, /apiKeyHelper' is not allowed/],
    ['env override of ANTHROPIC_* (still denied)', { edit: (j: any) => (j.claudeCode.env = { ANTHROPIC_BASE_URL: 'http://x' }) }, /claudeCode.env.ANTHROPIC_BASE_URL' is not allowed/],
    ['plugins', { edit: (j: any) => (j.claudeCode.settings = { enabledPlugins: { x: true } }) }, /enabledPlugins' is not allowed/],
  ])('rejects %s', (_name, extra, re) => {
    expect(() => load(ccConfig(extra as Parameters<typeof ccConfig>[0]))).toThrow(re);
  });

  it('rejects bin/ for the api backend', () => {
    const root = mkdtempSync(join(tmpdir(), 'cfg-api-'));
    roots.push(root);
    cpSync(join(CONFIGS_DIR, 'baseline-api'), join(root, 'a'), { recursive: true });
    mkdirSync(join(root, 'a', 'bin'));
    writeFileSync(join(root, 'a', 'bin', 'check'), CHECK);
    expect(() => loadConfigFromDir(join(root, 'a'), 'baseline-api')).toThrow(/bin\/ is only supported with backend 'claude-code'/);
  });

  it('loadConfig accepts an explicit directory path (id local/<dirname>) and guards it', () => {
    const dir = ccConfig({ bin: { check: CHECK } });
    const cfg = loadConfig(dir);
    expect(cfg.id).toBe('local/cc');
    expect(() => loadConfig(dir.replace(/cc$/, 'missing'))).toThrow(ConfigError);
  });
});

describe('claude-code installation helpers', () => {
  const cfg = () => load(ccConfig({ bin: { check: CHECK, trim: TRIM }, agents: { 'r.md': 'Review the API.\n' }, commands: { 'v.md': 'Verify.\n' }, edit: withHooks(HOOKS) }));

  it('places agents and commands under ~/.claude (never /workspace) and adds frontmatter to agents', () => {
    const files = claudeHomeFiles(cfg());
    const agent = files.find((f) => f.path === '/home/node/.claude/agents/r.md')!;
    expect(agent.content).toMatch(/^---\nname: r\ndescription: "Review the API\."\n---/);
    expect(files.find((f) => f.path === '/home/node/.claude/commands/v.md')!.content).toBe('Verify.\n');
    expect(files.every((f) => !f.path.startsWith('/workspace'))).toBe(true);
  });

  it('adds --include-hook-events only with hooks, and /opt/frugal/bin to PATH only with bin scripts', () => {
    expect(buildClaudeArgs(cfg())).toContain('--include-hook-events');
    const base = loadConfig('baseline');
    expect(buildClaudeArgs(base)).not.toContain('--include-hook-events');
    expect(buildClaudeEnv(cfg(), 'http://gw').PATH).toBe(`${FRUGAL_BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`);
    expect(buildClaudeEnv(base, 'http://gw').PATH).toBeUndefined();
  });

  it('installBinScripts writes script + audit wrapper as root and makes them read-only to node', async () => {
    const writes: { path: string; user?: string; content: string }[] = [];
    const execs: { cmd: string; user?: string }[] = [];
    const sb: ClaudeSandbox = {
      containerId: 'c',
      writeFileBuffer: async (path, content, o) => void writes.push({ path, user: o?.user, content: content.toString('utf8') }),
      exec: async (cmd, o) => (execs.push({ cmd, user: o?.user }), { exitCode: 0, stdout: '', stderr: '' }),
    };
    await installBinScripts(sb, cfg());
    expect(writes.map((w) => [w.path, w.user])).toEqual([
      ['/opt/frugal/libexec/check', 'root'],
      ['/opt/frugal/bin/check', 'root'],
      ['/opt/frugal/libexec/trim', 'root'],
      ['/opt/frugal/bin/trim', 'root'],
    ]);
    expect(writes[0].content).toBe(CHECK);
    expect(writes[1].content).toBe(binWrapper('check'));
    expect(execs[0]).toEqual({ cmd: expect.stringMatching(/chmod 0755 .*chmod 0555 \/opt\/frugal\/bin \/opt\/frugal\/libexec \/opt\/frugal$/), user: 'root' });
    expect(execs[1]).toEqual({ cmd: 'mkdir -p /tmp/.frugal', user: 'node' });
    // no bin scripts: nothing is installed
    const none: string[] = [];
    await installBinScripts({ ...sb, writeFileBuffer: async (p) => void none.push(p) }, loadConfig('baseline'));
    expect(none).toEqual([]);
  });

  it('binWrapper passes the exit code through and logs changed files', () => {
    const w = binWrapper('check');
    expect(w).toMatch(/^#!\/bin\/sh\n/);
    expect(w).toContain('/opt/frugal/libexec/check "$@"');
    expect(w).toContain('exit $rc');
    expect(w).toContain('-newer "$m"');
    expect(() => binWrapper('../x')).toThrow();
  });

  it('parses the audit log and the hook events of a stream', async () => {
    const log = [
      '{"ts":1794730398293,"script":"check","args":["a","b c"],"exitCode":3,"durationMs":2,"changedFiles":["/workspace/frontend/src/x.jsx"]}',
      'garbage',
      '',
    ].join('\n');
    const p = parseBinAuditLog(log);
    expect(p.malformed).toBe(1);
    expect(p.invocations).toEqual([{ ts: new Date(1794730398293).toISOString(), script: 'check', args: ['a', 'b c'], exitCode: 3, durationMs: 2, changedFiles: ['/workspace/frontend/src/x.jsx'] }]);
    const sb: ClaudeSandbox = { containerId: 'c', writeFileBuffer: async () => {}, exec: async () => ({ exitCode: 0, stdout: log, stderr: '' }) };
    expect(await readBinAuditLog(sb, cfg())).toMatchObject({ malformedLogLines: 1, logMissing: false });
    expect(await readBinAuditLog(sb, loadConfig('baseline'))).toEqual({ invocations: [], malformedLogLines: 0, logMissing: false });
    // Shapes observed with Claude Code 2.1.325 --include-hook-events
    const events = [
      { type: 'system', subtype: 'hook_started', hook_name: 'PostToolUse:Bash', hook_event: 'PostToolUse' },
      { type: 'system', subtype: 'hook_response', hook_name: 'PostToolUse:Bash', hook_event: 'PostToolUse', exit_code: 0, outcome: 'success' },
      { type: 'system', subtype: 'hook_response', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', exit_code: 0, outcome: 'success' },
      { type: 'system', subtype: 'hook_response', hook_name: 'PostToolUse:Bash', hook_event: 'PostToolUse', exit_code: 0, outcome: 'success' },
    ];
    expect(hookEventCounts(events)).toEqual({ 'PostToolUse:Bash': 2, 'PreToolUse:Bash': 1 });
  });
});
