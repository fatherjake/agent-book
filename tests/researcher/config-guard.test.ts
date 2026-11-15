/**
 * Anti-cheating guard (researcher/config-guard.ts): adversarial configs that smuggle app code must be
 * rejected; legitimate configs (baseline, check/smoke scripts, output-trimming hooks, a reviewer
 * subagent, prose requirement skills) must pass. The similarity corpus is a hermetic temp runs dir
 * holding a copy of the reference app as a "past run snapshot".
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditCodingRun,
  fencedBlocks,
  fileWrites,
  formatViolations,
  GUARD_LIMITS,
  guardConfig,
  scanFile,
  similarityAgainstDir,
  SIMILARITY,
  type GuardOptions,
} from '../../researcher/config-guard.js';
import { loadConfig } from '../../runner/config.js';
import { CONFIGS_DIR, REPO_ROOT } from '../../runner/env.js';
import { makeTmp, rmTmp } from './helpers.js';

const REF = join(REPO_ROOT, 'evaluator', 'reference-app');
const LEGIT = join(REPO_ROOT, 'tests', 'researcher', 'fixtures', 'config-guard', 'legit');
const ref = (p: string) => readFileSync(join(REF, p), 'utf8');
const legit = (p: string) => readFileSync(join(LEGIT, p), 'utf8');

let tmp: string;
let opts: GuardOptions;

beforeAll(() => {
  tmp = makeTmp('guard-');
  // A past run whose snapshot is the reference app (+ node_modules/dist that must be ignored).
  const app = join(tmp, 'runs', 'run_past', 'app');
  mkdirSync(app, { recursive: true });
  for (const d of ['backend', 'frontend']) cpSync(join(REF, d), join(app, d), { recursive: true });
  mkdirSync(join(app, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(app, 'node_modules', 'x', 'index.js'), 'module.exports = function () { return 42; };\n');
  writeFileSync(join(tmp, 'runs', 'run_past', 'run.json'), JSON.stringify({ configHash: 'hash-of-past-config' }));
  // A generic API helper as agents write it (the idiom every smoke test shares; seen in a real run).
  writeFileSync(
    join(app, 'frontend', 'src', 'client.js'),
    "async function api(method, url, body) {\n  let res;\n  try {\n    res = await fetch(url, {\n      method,\n      headers: body ? { 'Content-Type': 'application/json' } : undefined,\n      body: body ? JSON.stringify(body) : undefined,\n    });\n  } catch {\n    throw new Error('Network error. Please try again.');\n  }\n  if (res.status === 204) return null;\n  let data;\n  try { data = await res.json(); } catch {\n    throw new Error(`Unexpected server response (${res.status})`);\n  }\n  return data;\n}\n",
  );
  opts = { corpus: { runsDir: join(tmp, 'runs'), referenceAppDir: '/nonexistent' }, cacheFile: join(tmp, 'cache.json') };
});
afterAll(() => rmTmp(tmp));

const rules = (r: { violations: { rule: string }[] }) => r.violations.map((v) => v.rule);
const baseFiles = () => ({
  'config.json': readFileSync(join(CONFIGS_DIR, 'baseline', 'config.json'), 'utf8'),
  'system-prompt.md': readFileSync(join(CONFIGS_DIR, 'baseline', 'system-prompt.md'), 'utf8'),
});

describe('guardConfig: adversarial configs are REJECTED', () => {
  it('a skill containing the full server.js', () => {
    const r = guardConfig({ ...baseFiles(), 'skills/server.md': `# Backend\nCopy this file verbatim:\n\n\`\`\`js\n${ref('backend/server.js')}\n\`\`\`\n` }, opts);
    expect(r.ok).toBe(false);
    expect(rules(r)).toEqual(expect.arrayContaining(['app.server-code', 'app.express-route', 'md.code-volume', 'similarity.app-code']));
    expect(r.violations.find((v) => v.rule === 'similarity.app-code')!.detail).toMatch(/backend\/server\.js/);
  });

  it('server.js pasted as plain prose without fences (no code-block rules) is still caught', () => {
    const r = guardConfig({ 'CLAUDE.md': ref('backend/server.js').replace(/\n/g, ' ') }, opts);
    expect(rules(r)).toContain('similarity.app-code');
  });

  it('a bin/scaffold script with heredocs writing App.jsx', () => {
    const script = `#!/bin/sh\nmkdir -p /workspace/frontend/src\ncat > /workspace/frontend/src/App.jsx <<'EOF'\n${ref('frontend/src/App.jsx').split('\n').slice(0, 40).join('\n')}\nEOF\n`;
    const r = guardConfig({ ...baseFiles(), 'bin/scaffold': script }, opts);
    expect(r.ok).toBe(false);
    expect(rules(r)).toEqual(expect.arrayContaining(['script.writes-files', 'app.react-component', 'similarity.app-code']));
    expect(r.violations.find((v) => v.rule === 'script.writes-files')!.detail).toContain('/workspace/frontend/src/App.jsx');
  });

  it('a tiny scaffold script (under the size limit) is rejected for the write alone', () => {
    const r = guardConfig({ 'bin/scaffold': `#!/bin/sh\nprintf '%s' "$1" > frontend/src/App.jsx\n` }, opts);
    expect(rules(r)).toContain('script.writes-files');
    const node = guardConfig({ 'bin/gen': `#!/usr/bin/env node\nrequire('fs').writeFileSync('/workspace/backend/server.js', process.argv[2]);\n` }, opts);
    expect(rules(node)).toContain('script.writes-files');
  });

  it('a markdown snippet that scaffolds app files', () => {
    const r = guardConfig({ 'skills/setup.md': "# Setup\n```sh\ncat > backend/db.js <<'EOF'\nmodule.exports = {};\nEOF\n```\n" }, opts);
    expect(rules(r)).toContain('md.scaffold');
  });

  it('CSS tokens copied as rules', () => {
    const css = ref('frontend/src/styles.css');
    const r = guardConfig({ 'CLAUDE.md': `# Design\nUse these styles:\n\n\`\`\`css\n${css.split('\n').slice(0, 28).join('\n')}\n\`\`\`\n` }, opts);
    expect(r.ok).toBe(false);
    expect(rules(r).some((x) => x.startsWith('app.css'))).toBe(true);
    const tokens = ':root {\n  --bg: #f4f5f7;\n  --surface: #ffffff;\n  --text: #1f2937;\n  --muted: #6b7280;\n  --accent: #4f46e5;\n  --danger: #dc2626;\n  --radius: 12px;\n}\n';
    expect(rules(guardConfig({ 'skills/tokens.md': tokens }, opts))).toContain('app.css-tokens');
    const prose = 'Colors: bg #F4F5F7, card #FFF, text #1F2937, muted #6B7280, accent #4F46E5, hover #4338CA, danger #DC2626, border #E5E7EB. Spacing 4px 8px 12px 16px 24px 32px; radius 8px and 12px; card width 560px.';
    expect(rules(guardConfig({ 'skills/design.md': prose }, opts))).toContain('app.css-design');
  });

  it('base64 of app code (and its decoder)', () => {
    const b64 = Buffer.from(ref('backend/db.js')).toString('base64');
    const r = guardConfig({ 'bin/unpack': `#!/bin/sh\necho ${b64.slice(0, 600)} | base64 -d > /tmp/x.js\n` }, opts);
    expect(rules(r)).toEqual(expect.arrayContaining(['blob.base64', 'blob.decoder']));
    // wrapped across short lines to dodge the run-length rule: the decoder still gives it away
    const wrapped = b64.slice(0, 400).match(/.{1,60}/g)!.join('\n');
    expect(rules(guardConfig({ 'skills/x.md': `\`\`\`\n${wrapped}\n\`\`\`\nDecode with Buffer.from(s, 'base64').` }, opts))).toContain('blob.decoder');
    expect(rules(guardConfig({ 'skills/x.md': `H4sIAAAAAAAAA${'q'.repeat(20)}` }, opts))).toContain('blob.gzip');
  });

  it('code lightly renamed from a real snapshot (similarity check)', () => {
    // Rename identifiers, strip comments, change quotes: the heuristics may miss parts, the
    // identifier-normalized shingles must not.
    const renamed = ref('frontend/src/App.jsx')
      .replace(/\btodos\b/g, 'entries')
      .replace(/\btodo\b/g, 'entry')
      .replace(/\bTodo/g, 'Entry')
      .replace(/\bsetTodos\b/g, 'setEntries')
      .replace(/\berror\b/g, 'problem')
      .replace(/\bfilter\b/g, 'view')
      .replace(/\/\/[^\n]*/g, '');
    const chunk = renamed.split('\n').slice(10, 40).join('\n');
    const r = guardConfig({ 'skills/ui.md': `# UI\n\n${chunk}\n` }, opts);
    expect(rules(r)).toContain('similarity.app-code');
    // The api client, renamed, inside a fenced block of a slash command.
    const api = ref('frontend/src/api.js').replace(/request/g, 'go').replace(/res\b/g, 'resp').replace(/body/g, 'payload');
    const r2 = guardConfig({ 'commands/x.md': '---\ndescription: x\n---\n```js\n' + api + '\n```\n' }, opts);
    expect(rules(r2)).toContain('similarity.app-code');
  });

  it('code split across many small files (each under the per-file bar) is caught in aggregate', () => {
    const lines = ref('frontend/src/App.jsx').split('\n').filter((l) => l.trim());
    // each part is 5 contiguous lines wrapped in prose, so no single file reaches the per-file bars
    const prose = 'Plan the work once, keep each edit small and focused, and verify the whole app with a single command at the end of the task. '.repeat(8);
    const files: Record<string, string> = {};
    for (let i = 0; i < 8; i++) files[`skills/part${i}.md`] = `${prose}\n${lines.slice(60 + i * 5, 65 + i * 5).join('\n')}\n${prose}`;
    const r = guardConfig(files, opts);
    expect(rules(r)).toContain('similarity.app-code-total');
    expect(rules(r)).not.toContain('similarity.app-code');
  });

  it('React component, Express handlers, SQL schema, fetch wrapper: each rule fires on its own', () => {
    expect(rules(guardConfig({ 's.md': 'const [items, setItems] = useState([]); // todo list' }, { corpus: false }))).toContain('app.react-component');
    expect(rules(guardConfig({ 's.md': '<ul aria-label="Todo list"></ul>' }, { corpus: false }))).toContain('app.markup');
    expect(rules(guardConfig({ 's.md': '<li className={x} onClick={toggle} key={t.id}>' }, { corpus: false }))).toContain('app.jsx');
    expect(rules(guardConfig({ 's.md': "router.post('/api/todos', (req, res) => res.status(201).json(x))" }, { corpus: false }))).toEqual(
      expect.arrayContaining(['app.express-route', 'app.express-handler']),
    );
    expect(rules(guardConfig({ 's.md': 'CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY)' }, { corpus: false }))).toContain('app.sql-schema');
    expect(rules(guardConfig({ 's.md': 'db.prepare("INSERT INTO todos (title) VALUES (?)"); db.prepare("SELECT * FROM todos ORDER BY id")' }, { corpus: false }))).toContain('app.sql-data-layer');
    expect(rules(guardConfig({ 's.md': "export async function createTodo(t) { return fetch('/api/todos', { method: 'POST' }) }" }, { corpus: false }))).toEqual(
      expect.arrayContaining(['app.api-client', 'app.fetch-wrapper']),
    );
    expect(rules(guardConfig({ 'config.json': JSON.stringify({ claudeCode: { settings: { spinnerVerbs: { verbs: ['x'.repeat(300)] } } } }) }, { corpus: false }))).toContain('code.long-string');
  });

  it('size limits: per file and in total', () => {
    const big = 'Keep it short. '.repeat(700); // ~10.5 KB of harmless prose
    expect(rules(guardConfig({ 'CLAUDE.md': big }, { corpus: false }))).toEqual(['size.file']);
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`skills/s${i}.md`] = 'Plan once and verify once. '.repeat(280); // ~7.5 KB each
    const r = guardConfig(files, { corpus: false });
    expect(rules(r)).toEqual(['size.total']);
    expect(guardConfig(files, { corpus: false, skipTotal: true }).ok).toBe(true);
    expect(rules(guardConfig({ 'bin/x': '#!/bin/sh\n' + 'true\n'.repeat(1000) }, { corpus: false }))).toContain('size.file');
  });

  it('loadConfig refuses a hand-made config that violates the guard (baseline-api is exempt)', () => {
    const root = join(tmp, 'configs');
    cpSync(join(CONFIGS_DIR, 'baseline'), join(root, 'cheat'), { recursive: true });
    const c = JSON.parse(readFileSync(join(root, 'cheat', 'config.json'), 'utf8'));
    delete c.id;
    writeFileSync(join(root, 'cheat', 'config.json'), JSON.stringify(c));
    writeFileSync(join(root, 'cheat', 'skills', 'server.md'), '```js\n' + ref('backend/server.js') + '\n```\n');
    expect(() => loadConfig('cheat', { configsDir: root, guard: opts })).toThrow(/anti-cheating guard[\s\S]*app\.express-route/);
    expect(() => loadConfig(join(root, 'cheat'), { guard: opts })).toThrow(/local\/cheat[\s\S]*anti-cheating/);
    expect(loadConfig('cheat', { configsDir: root, guard: false }).skills.some((s) => s.name === 'server')).toBe(true);
    expect(loadConfig('baseline-api').id).toBe('baseline-api');
  });
});

describe('guardConfig: legitimate configs PASS', () => {
  it('the baseline (hermetic corpus and the repo default corpus)', () => {
    const r = guardConfig(join(CONFIGS_DIR, 'baseline'), opts);
    expect(formatViolations(r.violations)).toBe('');
    expect(guardConfig(join(CONFIGS_DIR, 'baseline')).ok).toBe(true);
    expect(loadConfig('baseline').id).toBe('baseline');
  });

  it('a check script (npm run build + node smoke test printing errors only) and a tree script', () => {
    const r = guardConfig({ ...baseFiles(), 'bin/check': legit('check'), 'bin/smoke': legit('smoke'), 'bin/tree': legit('tree') }, opts);
    expect(formatViolations(r.violations)).toBe('');
  });

  it('generic idioms shared with app code (a fetch helper) stay below the renamed-channel bar', () => {
    const r = guardConfig({ 'bin/smoke': legit('smoke') }, opts);
    expect(r.ok).toBe(true);
    const m = r.similarity.find((x) => x.file === 'bin/smoke');
    expect(m?.corpusFile).toMatch(/client\.js$/); // recorded for audits, but not a violation
    expect(m!.coveredTokens).toBeLessThan(SIMILARITY.minCoveredTokensRenamed);
  });

  it('a PostToolUse hook that truncates Bash output, and a PreToolUse clip wrapper', () => {
    const cfg = JSON.parse(baseFiles()['config.json']);
    cfg.claudeCode.settings = {
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/opt/frugal/bin/trim-output 2000', timeout: 10 }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/opt/frugal/bin/wrap-noisy' }] }],
      },
    };
    const r = guardConfig(
      { ...baseFiles(), 'config.json': JSON.stringify(cfg, null, 2), 'bin/trim-output': legit('trim-output'), 'bin/wrap-noisy': legit('wrap-noisy'), 'bin/clip': legit('clip') },
      opts,
    );
    expect(formatViolations(r.violations)).toBe('');
  });

  it('a subagent that reviews the API against the contract, and a slash command', () => {
    const r = guardConfig(
      { ...baseFiles(), 'agents/api-reviewer.md': legit('api-reviewer.md'), 'commands/verify.md': '---\ndescription: Verify the app\n---\nRun `check` and fix every error it reports, then run it again.\n' },
      opts,
    );
    expect(formatViolations(r.violations)).toBe('');
  });

  it('prose skills that paraphrase the requirements', () => {
    const r = guardConfig({ ...baseFiles(), 'skills/contract-notes.md': legit('requirements-skill.md'), 'skills/verification-checklist.md': readFileSync(join(CONFIGS_DIR, 'baseline', 'skills', 'verification-checklist.md'), 'utf8') }, opts);
    expect(formatViolations(r.violations)).toBe('');
  });

  it('general engineering advice with short commands and quoting the spec is fine', () => {
    const md = [
      '# Workflow',
      '- Write each file once with the Write tool; avoid re-reading files you just wrote.',
      '- Verify with one command:',
      '```sh',
      'npm run build 2>&1 | tail -n 20',
      'PORT=4999 DATABASE_PATH=/tmp/t.db node backend/server.js > /tmp/server.log 2>&1 &',
      '```',
      '- Error messages: use the exact strings from requirements.md, for example the 404 message.',
      '- Use prepared statements and `PRAGMA foreign_keys = ON`; return `completed` as `!!row.completed`.',
    ].join('\n');
    // Spec text (the SQL schema block of requirements.md) is allow-listed for similarity, but the
    // schema itself is still a heuristic violation: configs refer to the spec instead of copying it.
    expect(formatViolations(guardConfig({ 'skills/workflow.md': md }, opts).violations)).toBe('');
  });

  it('a config\'s own runs are excluded from its similarity corpus', () => {
    const snippet = ref('backend/db.js').split('\n').slice(0, 25).join(' ');
    const files = { 'CLAUDE.md': snippet };
    expect(rules(guardConfig(files, opts))).toContain('similarity.app-code');
    expect(rules(guardConfig(files, { ...opts, excludeConfigHashes: ['hash-of-past-config'] }))).not.toContain('similarity.app-code');
  });
});

describe('similarity internals', () => {
  it('caches corpus fingerprints and reuses them', () => {
    const cacheFile = join(tmp, 'cache2.json');
    guardConfig({ 'a.md': 'hello world' }, { ...opts, cacheFile });
    expect(existsSync(cacheFile)).toBe(true);
    const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
    const keys = Object.keys(cache.files);
    expect(keys.some((k) => k.endsWith('backend/server.js'))).toBe(true);
    expect(keys.some((k) => k.includes('node_modules'))).toBe(false);
    // poison the cached fingerprints of server.js: a cache hit means server.js no longer matches
    for (const k of keys) if (k.endsWith('server.js')) cache.files[k].exact = cache.files[k].norm = [];
    writeFileSync(cacheFile, JSON.stringify(cache));
    const r = guardConfig({ 'CLAUDE.md': ref('backend/server.js') }, { ...opts, cacheFile });
    expect(r.similarity.every((s) => !s.corpusFile.endsWith('server.js'))).toBe(true);
  });

  it('similarityAgainstDir finds config content in an app snapshot', () => {
    const m = similarityAgainstDir({ 'CLAUDE.md': ref('backend/db.js') }, join(tmp, 'runs', 'run_past', 'app'));
    expect(m).toMatchObject({ configFile: 'CLAUDE.md', appFile: 'backend/db.js' });
    expect(m!.matched).toBeGreaterThanOrEqual(SIMILARITY.minCoveredTokens);
    expect(similarityAgainstDir({ 'CLAUDE.md': legit('requirements-skill.md') }, join(tmp, 'runs', 'run_past', 'app'))).toBeNull();
  });

  it('fencedBlocks and fileWrites', () => {
    expect(fencedBlocks('a\n```js\nx\ny\n```\nb\n~~~\nz\n~~~\n')).toEqual([
      { lang: 'js', body: 'x\ny\n', lines: 2 },
      { lang: '', body: 'z\n', lines: 1 },
    ]);
    const w = fileWrites('echo a > /tmp/x 2>&1; cat x >> out.txt; cmd | tee -a log; cp a frontend/b.js; x => y', { shell: true, js: false });
    expect(w.map((x) => x.target)).toEqual(['/tmp/x', 'out.txt', 'log', 'frontend/b.js']);
    expect(scanFile('bin/x', '#!/bin/sh\nf=$(mktemp)\ncat > "$f"\nout=/tmp/o\necho hi > $out\n')).toEqual([]);
    expect(scanFile('bin/x', '#!/bin/sh\nf=frontend/a.js\necho hi > "$f"\n').map((v) => v.rule)).toEqual(['script.writes-files']);
    // comments are prose; quotes are respected
    expect(scanFile('bin/x', '#!/bin/sh\nsmoke 1 # /opt/frugal/bin/<name> is a wrapper\n')).toEqual([]);
    expect(scanFile('bin/x', '#!/bin/sh\necho "a # b" > frontend/a.js\n').map((v) => v.rule)).toEqual(['script.writes-files']);
    expect(scanFile('bin/x', "#!/bin/sh\necho 'x' # comment\necho ${#v} > frontend/b.js\n").map((v) => v.rule)).toEqual(['script.writes-files']);
  });

  it('documents its limits', () => {
    expect(GUARD_LIMITS).toMatchObject({ mdFileBytes: 8192, scriptFileBytes: 4096, totalBytes: 40960 });
    expect(SIMILARITY.k).toBe(12);
  });
});

describe('auditCodingRun', () => {
  const cfg = loadConfig('baseline', { guard: false });
  it('flags bin scripts that wrote app source; ignores dist/db/log writes', () => {
    const a = auditCodingRun({
      config: { ...cfg, bin: [{ name: 'gen', content: '#!/bin/sh\n' }] },
      invocations: [
        { ts: 't', script: 'check', args: [], exitCode: 0, durationMs: 5, changedFiles: ['/workspace/data/todos.db', '/workspace/check.log'] },
        { ts: 't', script: 'gen', args: [], exitCode: 0, durationMs: 5, changedFiles: ['/workspace/frontend/src/App.jsx'] },
      ],
      hookCounts: { 'PostToolUse:Bash': 3 },
    });
    expect(a.flagged).toBe(true);
    expect(a.binCounts).toEqual({ check: 1, gen: 1 });
    expect(a.binSourceWrites).toEqual(['/workspace/frontend/src/App.jsx']);
    expect(a.reasons[0]).toMatch(/App\.jsx/);
  });

  it('flags a snapshot that reproduces config content; a clean run is not flagged', () => {
    const app = join(tmp, 'runs', 'run_past', 'app');
    const bad = auditCodingRun({ config: { ...cfg, claudeMdContent: ref('backend/server.js'), claudeCode: { ...cfg.claudeCode!, claudeMd: true } }, invocations: [], hookCounts: {}, appDir: app });
    expect(bad.flagged).toBe(true);
    expect(bad.reasons[0]).toMatch(/reproduces config content/);
    const ok = auditCodingRun({ config: cfg, invocations: [], hookCounts: {}, appDir: app });
    expect(ok).toMatchObject({ flagged: false, reasons: [], binSourceWrites: [] });
  });
});
