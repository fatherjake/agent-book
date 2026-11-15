/**
 * Anti-cheating guard for coding-agent configurations (TASK.md §9: "The researcher must not reuse
 * application code generated during previous runs. Only optimized agent configurations can carry
 * forward.").
 *
 * The research agent can read past coding transcripts, which contain generated app code. A config
 * that smuggles that code (or any todo-app implementation) into a skill, CLAUDE.md, a bin script, a
 * subagent or a slash command would show huge fake "token savings". guardConfig() rejects such configs
 * with three independent layers:
 *
 *  1. Size limits (GUARD_LIMITS): per file and in total. A real implementation does not fit.
 *  2. App-code heuristics (rule ids below) over ALL config text, including code blocks in markdown
 *     and JSON string values: Express routes / server bootstrap, the todos SQL schema and data layer,
 *     React components and JSX markup, browser fetch wrappers for /api, CSS rule blocks and design
 *     token sheets, scripts or snippets that write files into the app, encoded/compressed blobs and
 *     long string literals. Prose that describes requirements and general engineering advice passes.
 *  3. Similarity: winnowed token k-gram fingerprints (k = 12) of every config file are compared with
 *     every app snapshot under results/runs/<id>/app and evaluator/reference-app (exact AND
 *     identifier-normalized, so light renaming is still caught). k-grams that also occur in the
 *     starter repo or the frozen spec are ignored (quoting the spec is not reuse). Corpus fingerprints
 *     are cached in results/.cache/config-guard-fingerprints.json (keyed by path, size, mtime).
 *
 * Enforced by researcher/optimizer.ts applyProposal (violations go back to the research agent through
 * researcher/whitelist.ts validateProposal, so its single retry can fix them) and by runner/config.ts
 * loadConfig (every config except 'baseline-api'). auditCodingRun() is the runtime counterpart used
 * by runner/run.ts after each claude-code run.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { AgentConfig, BinInvocation, ConfigRunAudit } from '../runner/types.js';
import { REPO_ROOT, resultsDir } from '../runner/env.js';

// ---------------------------------------------------------------------------
// Limits and thresholds (documented in README "Anti-cheating guard")
// ---------------------------------------------------------------------------

export const GUARD_LIMITS = {
  /** Any markdown file: system-prompt.md, CLAUDE.md, skills/*.md, agents/*.md, commands/*.md. */
  mdFileBytes: 8 * 1024,
  /** Each bin/<name> script. */
  scriptFileBytes: 4 * 1024,
  /** config.json, tools.json. */
  jsonFileBytes: 8 * 1024,
  /** Whole config (every file). */
  totalBytes: 40 * 1024,
  /** Lines in one fenced markdown code block / all fenced code of one markdown file. */
  maxCodeBlockLines: 30,
  maxCodeLinesPerFile: 60,
  /** A quoted string literal in code (scripts, code blocks, JSON values) longer than this. */
  longStringChars: 240,
  /** A single script line longer than this. */
  longScriptLineChars: 400,
  /** Encoded blobs: base64-alphabet run / hex run length. */
  base64RunChars: 100,
  hexRunChars: 128,
  /** CSS: declarations in rule blocks; hex colors AND px values together; custom properties. */
  cssDeclarations: 12,
  cssHexColors: 8,
  cssPxValues: 8,
  cssCustomProperties: 6,
  /** JSX attribute expressions (onClick={...}, className={...}, ...) in one file. */
  jsxAttrExpressions: 3,
  /** HTML/JSX element tags with attributes in one file. */
  markupTags: 2,
  /** Distinct SQL statement kinds on the todos table (INSERT/UPDATE/DELETE/SELECT). */
  sqlStatementKinds: 2,
  /** Express-style (req, res) handler signatures in one file. */
  expressHandlers: 2,
} as const;

export const SIMILARITY = {
  /** Tokens per shingle. */
  k: 12,
  /** Winnowing window (corpus side): guarantees detection of any shared run of >= k + w - 1 tokens. */
  window: 4,
  /** Verbatim channel: reject when this many tokens of one config file are covered by k-grams found in app code ... */
  minCoveredTokens: 80,
  /** ... or when at least this fraction is covered (and at least minCoveredTokensForRatio tokens). */
  minCoverage: 0.25,
  minCoveredTokensForRatio: 30,
  /**
   * Identifier-renamed channel: a higher bar, because generic idioms (e.g. the
   * fetch(url, { method, headers, body: JSON.stringify(body) }) helper every smoke test and API client
   * shares) look alike once identifiers are erased. Real copies cover hundreds of tokens; the verbatim
   * bar (80 tokens, ~6-8 lines) also leaves room for such idioms written with the same names.
   */
  minCoveredTokensRenamed: 120,
  /** Whole config: covered tokens summed over all files (catches code split across many small files). */
  minCoveredTokensTotal: 160,
  minCoveredTokensForRatioRenamed: 60,
  /** Corpus files larger than this are skipped (bundles, generated output). */
  maxCorpusFileBytes: 256 * 1024,
} as const;

/** Corpus file extensions (app source). Markdown/JSON/lockfiles are excluded. */
const CORPUS_EXT_RE = /\.(?:[cm]?[jt]sx?|css|scss|html?|sql)$/i;
const CORPUS_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.vite', 'coverage', '.cache']);
/** Files in a config dir that are metadata, never installed for the agent. */
const META_FILES = new Set(['meta.json', 'REJECTED', 'resolved.json', 'hash.txt']);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GuardViolation {
  file: string;
  rule: string;
  detail: string;
}

export interface GuardResult {
  ok: boolean;
  violations: GuardViolation[];
  /** Best similarity match per config file (for audits; only files with any overlap). */
  similarity: { file: string; corpusFile: string; coveredTokens: number; coverage: number }[];
}

export interface GuardOptions {
  /**
   * Similarity corpus. false disables the similarity layer (unit tests of the heuristics only).
   * Defaults: runsDir = <results>/runs, referenceAppDir = evaluator/reference-app,
   * allowDirs (k-grams ignored) = benchmark/starter + benchmark/spec.
   */
  corpus?: false | { runsDir?: string; referenceAppDir?: string; extraDirs?: string[]; allowDirs?: string[] };
  /** Fingerprint cache file; false = no cache. Default <results>/.cache/config-guard-fingerprints.json. */
  cacheFile?: string | false;
  /** Skip the total-size check (used when only the changed files of a proposal are checked). */
  skipTotal?: boolean;
  /**
   * Ignore snapshots of runs made WITH these config hashes (run.json configHash). A config's own runs
   * post-date it, so they cannot be its source; without this a legit config could self-invalidate when
   * the agent echoes a short allowed snippet into the app. runner/config.ts loadConfig passes the hash.
   */
  excludeConfigHashes?: string[];
}

/** Guard a config directory or a files map (relative path → content). */
export function guardConfig(input: string | Record<string, string>, opts: GuardOptions = {}): GuardResult {
  const files = typeof input === 'string' ? readConfigDirFiles(input) : input;
  const violations: GuardViolation[] = [];
  let total = 0;
  for (const [file, content] of Object.entries(files)) {
    if (META_FILES.has(file)) continue;
    const bytes = Buffer.byteLength(content, 'utf8');
    total += bytes;
    const kind = fileKind(file);
    const limit = kind === 'script' ? GUARD_LIMITS.scriptFileBytes : kind === 'json' ? GUARD_LIMITS.jsonFileBytes : GUARD_LIMITS.mdFileBytes;
    if (bytes > limit) violations.push({ file, rule: 'size.file', detail: `${bytes} bytes > ${limit} (${kind} limit)` });
    violations.push(...scanFile(file, content, kind));
  }
  if (!opts.skipTotal && total > GUARD_LIMITS.totalBytes)
    violations.push({ file: '*', rule: 'size.total', detail: `config totals ${total} bytes > ${GUARD_LIMITS.totalBytes}` });

  const similarity: GuardResult['similarity'] = [];
  if (opts.corpus !== false) {
    const corpus = loadCorpus(opts);
    let totalCovered = 0;
    for (const [file, content] of Object.entries(files)) {
      if (META_FILES.has(file)) continue;
      const m = matchAgainst(content, corpus);
      if (!m) continue;
      totalCovered += m.coveredTokens;
      similarity.push({ file, corpusFile: m.corpusFile, coveredTokens: m.coveredTokens, coverage: round(m.coverage) });
      if (exceedsSimilarity(m))
        violations.push({
          file,
          rule: 'similarity.app-code',
          detail: `${m.coveredTokens} tokens (${Math.round(m.coverage * 100)}%) match app code in ${m.corpusFile} (${m.channel === 'exact' ? 'verbatim' : 'identifier-renamed'})`,
        });
    }
    if (totalCovered >= SIMILARITY.minCoveredTokensTotal && !violations.some((x) => x.rule === 'similarity.app-code'))
      violations.push({ file: '*', rule: 'similarity.app-code-total', detail: `${totalCovered} tokens across config files match app code from earlier runs (>= ${SIMILARITY.minCoveredTokensTotal})` });
  }
  return { ok: violations.length === 0, violations, similarity };
}

/** One violation per line, for error messages and the research agent's retry. */
export function formatViolations(v: GuardViolation[]): string {
  return v.map((x) => `- ${x.file}: [${x.rule}] ${x.detail}`).join('\n');
}

/** The files of an AgentConfig in on-disk layout (for guarding in-memory configs and run audits). */
export function configFilesOf(cfg: AgentConfig): Record<string, string> {
  const out: Record<string, string> = { 'system-prompt.md': cfg.systemPrompt };
  for (const s of cfg.skills) out[`skills/${s.name}.md`] = s.content;
  if (cfg.claudeMdContent !== undefined) out['CLAUDE.md'] = cfg.claudeMdContent;
  for (const b of cfg.bin ?? []) out[`bin/${b.name}`] = b.content;
  for (const a of cfg.agents ?? []) out[`agents/${a.name}.md`] = a.content;
  for (const c of cfg.commands ?? []) out[`commands/${c.name}.md`] = c.content;
  if (cfg.claudeCode) out['config.json'] = JSON.stringify({ claudeCode: cfg.claudeCode });
  return out;
}

/** Read every file of a config dir (recursively), skipping metadata and dotfiles. */
export function readConfigDirFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const rel = relative(dir, p).split('\\').join('/');
        if (!META_FILES.has(rel)) out[rel] = readFileSync(p, 'utf8');
      }
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// Layer 2: heuristics
// ---------------------------------------------------------------------------

type Kind = 'md' | 'script' | 'json' | 'other';
function fileKind(file: string): Kind {
  if (file.startsWith('bin/')) return 'script';
  if (file.endsWith('.md')) return 'md';
  if (file.endsWith('.json')) return 'json';
  return 'other';
}

interface Unit {
  /** Code (script, fenced block, JSON string) vs prose (whole markdown text). */
  code: boolean;
  lang: string;
  text: string;
  where: string;
}

const SHELL_LANGS = new Set(['sh', 'bash', 'shell', 'zsh', 'console', 'shell-session']);

/** Fenced code blocks of a markdown text. */
export function fencedBlocks(md: string): { lang: string; body: string; lines: number }[] {
  const out: { lang: string; body: string; lines: number }[] = [];
  const re = /^ {0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+-]*)[^\n]*\n([\s\S]*?)^ {0,3}\1[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) out.push({ lang: m[2].toLowerCase(), body: m[3], lines: m[3].split('\n').filter((l) => l.trim()).length });
  // An unterminated fence: everything after it is code.
  const opened = (md.match(/^ {0,3}(`{3,}|~{3,})/gm) ?? []).length;
  if (opened % 2 === 1) {
    const last = md.lastIndexOf('```');
    const body = md.slice(md.indexOf('\n', last) + 1);
    out.push({ lang: '', body, lines: body.split('\n').filter((l) => l.trim()).length });
  }
  return out;
}

function jsonStrings(text: string): { path: string; value: string }[] {
  const out: { path: string; value: string }[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [{ path: '(unparsed)', value: text }];
  }
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'string') out.push({ path, value: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(parsed, '');
  return out;
}

function unitsOf(file: string, content: string, kind: Kind): Unit[] {
  if (kind === 'script') {
    const lang = /^#!.*\bnode\b/.test(content) ? 'js' : 'sh';
    return [{ code: true, lang, text: content, where: file }];
  }
  if (kind === 'json') {
    const strs = jsonStrings(content).filter((s) => !/(^|\.)(description|id|parentId|hypothesis|changeSummary)$/.test(s.path));
    return [{ code: true, lang: 'json', text: strs.map((s) => s.value).join('\n'), where: file }];
  }
  const units: Unit[] = [{ code: false, lang: 'md', text: content, where: file }];
  for (const b of fencedBlocks(content)) units.push({ code: true, lang: b.lang, text: b.body, where: `${file} (\`\`\`${b.lang || 'code'} block)` });
  return units;
}

const count = (re: RegExp, s: string) => (s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) ?? []).length;

/** All heuristic violations of one file. */
export function scanFile(file: string, content: string, kind: Kind = fileKind(file)): GuardViolation[] {
  const v: GuardViolation[] = [];
  const add = (rule: string, detail: string) => {
    if (!v.some((x) => x.rule === rule)) v.push({ file, rule, detail });
  };
  const units = unitsOf(file, content, kind);
  const all = content;

  // --- encoded / compressed payloads (anywhere) ---
  const b64 = new RegExp(`[A-Za-z0-9+/_-]{${GUARD_LIMITS.base64RunChars},}={0,2}`, 'g');
  for (const m of all.match(b64) ?? []) {
    if (/[0-9]/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m) && !/^[A-Za-z_-]+$/.test(m)) {
      add('blob.base64', `base64-like run of ${m.length} chars: ${m.slice(0, 40)}...`);
      break;
    }
  }
  const hex = new RegExp(`\\b[0-9a-fA-F]{${GUARD_LIMITS.hexRunChars},}\\b`);
  if (hex.test(all)) add('blob.hex', `hex run of >= ${GUARD_LIMITS.hexRunChars} chars`);
  if (/H4sI[A-Za-z0-9+/]{8}/.test(all)) add('blob.gzip', 'base64 gzip header (H4sI...)');
  if (count(/\\x[0-9a-fA-F]{2}/, all) >= 16 || count(/\\u[0-9a-fA-F]{4}/, all) >= 16) add('blob.escapes', 'many \\x/\\u escape sequences');
  const decoder =
    /\bbase64\s+(?:-d|-D|--decode)\b|\batob\s*\(|Buffer\.from\([^)]*['"](?:base64|base64url|hex)['"]|\b(?:gunzip|zcat|uudecode|unxz|bunzip2)\b|\bxxd\s+-r\b|\bopenssl\s+(?:enc|base64)\b|\bzlib\b|\binflate(?:Raw)?Sync\b|\bbrotliDecompress|\bfromCharCode\s*\(/;
  const dm = decoder.exec(all);
  if (dm) add('blob.decoder', `decoder/decompressor usage: ${dm[0]}`);

  // --- task-specific implementation artifacts (anywhere, prose included: they are syntax, not prose) ---
  const schema = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"'[]?todos\b/i.exec(all);
  if (schema) add('app.sql-schema', `SQL schema for the todos table: "${schema[0]}" (refer to the spec instead)`);
  const sqlKinds = [
    /\bINSERT\s+INTO\s+[`"']?todos\b/i,
    /\bUPDATE\s+[`"']?todos\s+SET\b/i,
    /\bDELETE\s+FROM\s+[`"']?todos\b/i,
    /\bSELECT\b[^;]{0,200}?\bFROM\s+[`"']?todos\b/i,
  ].filter((re) => re.test(all)).length;
  if (sqlKinds >= GUARD_LIMITS.sqlStatementKinds) add('app.sql-data-layer', `${sqlKinds} kinds of SQL statements on the todos table`);
  const serverImport = /\brequire\(\s*['"](?:express|better-sqlite3)['"]\s*\)|\bfrom\s+['"](?:express|better-sqlite3)['"]|\bimport\s+(?:express|Database)\b[^\n;]*\bfrom\b/.exec(all);
  if (serverImport) add('app.server-code', `server implementation import: ${serverImport[0]}`);
  const route = /\b(?:app|router|api|server)\s*\.\s*(?:get|post|put|patch|delete|all|use)\s*\(\s*['"`]\/(?:api\b|\*|:)?/.exec(all);
  if (route) add('app.express-route', `Express route definition: ${route[0]}`);
  const handlers = count(/\(\s*req\s*,\s*res\s*(?:,\s*next\s*)?\)\s*=>|\bfunction\s*\w*\s*\(\s*req\s*,\s*res\b/, all);
  if (handlers >= GUARD_LIMITS.expressHandlers || (handlers >= 1 && /\bres\s*\.\s*(?:status|json|send)\s*\(/.test(all)))
    add('app.express-handler', `${handlers} (req, res) handler(s)`);
  if (/\buse(?:State|Reducer)\s*[(<]/.test(all) && /todo/i.test(all)) add('app.react-component', 'React state hook together with todo data');
  const jsxAttrs = count(/\b(?:on[A-Z][A-Za-z]+|className|htmlFor|key|value|checked|disabled|ref|style|aria-[a-z]+)=\{/, all);
  if (jsxAttrs >= GUARD_LIMITS.jsxAttrExpressions) add('app.jsx', `${jsxAttrs} JSX attribute expressions`);
  const tags = all.match(/<(?:ul|ol|li|form|input|button|section|main|header|footer|div|span|label|h[1-6]|p|nav|article|textarea|select|App|Todo\w*)\b[^<>\n]*\b(?:aria-[a-z]+|class(?:Name)?|role|id|type|on[A-Za-z]+|htmlFor|for|placeholder)\s*=[^<>\n]*\/?>/g) ?? [];
  if (tags.length >= GUARD_LIMITS.markupTags || tags.some((t) => /aria-label\s*=\s*[{"'`][^>]*todo/i.test(t)))
    add('app.markup', `UI markup: ${tags.slice(0, 2).join(' ').slice(0, 120)}`);
  if (/\bReactDOM\b|\bcreateRoot\s*\(|\bexport\s+default\s+function\s+[A-Z]\w*\s*\(/.test(all)) add('app.react-component', 'React component/entry code');
  const apiFn = /\b(?:export\s+)?(?:async\s+)?function\s+(?:get|list|load|fetch|create|add|update|toggle|delete|remove|clear|save|patch)\w*Todos?\b|\b(?:const|let)\s+(?:get|list|load|fetch|create|add|update|toggle|delete|remove|clear|save|patch)\w*Todos?\s*=\s*(?:async\s*)?\(/i.exec(all);
  if (apiFn) add('app.api-client', `todo API client function: ${apiFn[0]}`);
  const relFetch = /\bfetch\s*\(\s*[`'"]\/api\b|\bfetch\s*\(\s*`\$\{[A-Za-z_$][\w$.]*\}\/api\/todos/.exec(all);
  if (relFetch) add('app.fetch-wrapper', `browser-relative fetch of the API: ${relFetch[0]}`);

  // --- CSS (anywhere) ---
  let decls = 0;
  for (const block of all.match(/[^{}\n;]{1,200}\{[^{}]*\}/g) ?? []) {
    const body = block.slice(block.indexOf('{') + 1, -1);
    decls += count(/(?:^|[;{\s])-{0,2}[a-z][a-z-]*\s*:\s*[^;{}\n]+;/, body);
  }
  if (decls > GUARD_LIMITS.cssDeclarations) add('app.css-rules', `${decls} CSS declarations in rule blocks (> ${GUARD_LIMITS.cssDeclarations})`);
  const hexColors = count(/#[0-9a-fA-F]{3,8}\b/, all);
  const px = count(/\b\d+(?:\.\d+)?px\b/, all);
  if (hexColors >= GUARD_LIMITS.cssHexColors && px >= GUARD_LIMITS.cssPxValues)
    add('app.css-design', `${hexColors} hex colors and ${px} px values (design reproduction; the agent reads design-tokens.md itself)`);
  const customProps = count(/(?:^|[;{\s])--[a-zA-Z][\w-]*\s*:\s*[^;{}\n]+;/, all);
  if (customProps >= GUARD_LIMITS.cssCustomProperties) add('app.css-tokens', `${customProps} CSS custom property declarations`);

  // --- code-unit rules ---
  let codeLines = 0;
  for (const u of units) {
    if (!u.code) continue;
    const lines = u.text.split('\n').filter((l) => l.trim()).length;
    if (kind === 'md' || kind === 'other') {
      codeLines += lines;
      if (lines > GUARD_LIMITS.maxCodeBlockLines) add('md.code-volume', `${u.where}: ${lines} lines of code (> ${GUARD_LIMITS.maxCodeBlockLines} per block)`);
    }
    for (const m of u.text.match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? []) {
      if (m.length - 2 > GUARD_LIMITS.longStringChars) {
        add('code.long-string', `${u.where}: string literal of ${m.length - 2} chars (> ${GUARD_LIMITS.longStringChars})`);
        break;
      }
    }
    if (kind === 'json') {
      for (const s of u.text.split('\n'))
        if (s.length > GUARD_LIMITS.longStringChars) add('code.long-string', `JSON string value of ${s.length} chars (> ${GUARD_LIMITS.longStringChars})`);
    }
    if (kind === 'script') {
      const long = u.text.split('\n').find((l) => l.length > GUARD_LIMITS.longScriptLineChars);
      if (long) add('code.long-line', `script line of ${long.length} chars (> ${GUARD_LIMITS.longScriptLineChars})`);
    }
    const isShell = u.lang === 'sh' || SHELL_LANGS.has(u.lang) || (u.lang === '' && /(^|\n)\s*(cat|echo|printf|tee|cp|mv|sed|npm|node|cd)\b/.test(u.text));
    const isJs = u.lang === 'js' || /^(js|javascript|mjs|cjs|ts|typescript|node)$/.test(u.lang) || /\brequire\(|\bimport\s.+from\b/.test(u.text);
    const strict = kind === 'script';
    // bin scripts: shell rules for sh scripts, JS rules for both (sh scripts can embed node -e code).
    for (const w of fileWrites(u.text, { shell: strict ? u.lang === 'sh' : isShell, js: isJs || strict })) {
      if (strict ? !isTmpTarget(w.target, u.text) : isAppTarget(w.target))
        add(strict ? 'script.writes-files' : 'md.scaffold', `${u.where}: ${w.how} writes ${w.target}${strict ? ' (bin scripts may only write under /tmp; they must not generate app source)' : ''}`);
    }
  }
  if ((kind === 'md' || kind === 'other') && codeLines > GUARD_LIMITS.maxCodeLinesPerFile)
    add('md.code-volume', `${codeLines} lines of fenced code in total (> ${GUARD_LIMITS.maxCodeLinesPerFile})`);
  return v;
}

/** File-writing operations in shell or JS code, with their (literal or variable) targets. */
export function fileWrites(text: string, opts: { shell: boolean; js: boolean }): { how: string; target: string }[] {
  const out: { how: string; target: string }[] = [];
  if (opts.shell) text = stripShellComments(text);
  if (opts.shell) {
    // redirections (not 2>&1, >&2, <<, heredoc markers), tee, and file-copying/patching commands
    for (const m of text.matchAll(/(?:^|[^<>&0-9=-])(>{1,2}\|?)\s*(?!&)(["']?)([^\s"';|&)<>]+)\2/gm)) out.push({ how: `redirect ${m[1]}`, target: m[3] });
    for (const m of text.matchAll(/\btee\s+(?:-a\s+)?(["']?)([^\s"';|&)]+)\1/g)) out.push({ how: 'tee', target: m[2] });
    for (const m of text.matchAll(/\b(cp|mv|install|ln|rsync|touch|dd|patch|git\s+apply|sed\s+-i\S*|perl\s+-\w*i\w*)\b([^\n;|&]*)/g)) {
      const args = m[2].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'));
      const target = m[1] === 'touch' || m[1].startsWith('sed') || m[1].startsWith('perl') || m[1] === 'patch' || m[1].startsWith('git') ? args[args.length - 1] ?? '' : args[args.length - 1] ?? '';
      if (target) out.push({ how: m[1].split(/\s+/)[0], target: target.replace(/^["']|["']$/g, '') });
    }
  }
  if (opts.js) {
    for (const m of text.matchAll(/\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile|cpSync|renameSync|rename|symlinkSync|openSync)\s*\(\s*([^,)]*)/g))
      out.push({ how: m[1], target: m[2].trim() });
  }
  return out;
}

/**
 * Remove shell comments (a # at the start of a word, outside quotes) so prose in comments is not read
 * as code. Quote-aware, so `echo "a # b" > file` keeps its redirect.
 */
export function stripShellComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let q: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
          if (c === '\\' && q === '"') i++;
          else if (c === q) q = null;
        } else if (c === '\\') i++;
        else if (c === '"' || c === "'") q = c;
        else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/** Strict target check for bin scripts: only /tmp, /dev, mktemp results or tmpdir() paths. */
function isTmpTarget(target: string, script: string): boolean {
  const t = target.replace(/^["'`]|["'`]$/g, '');
  if (/^\/dev\/(null|stdout|stderr|fd\/\d)$/.test(t)) return true;
  if (/^\/tmp(\/|$)/.test(t) || /^\$\{?TMPDIR\}?(\/|$)/.test(t) || /\b(os\.)?tmpdir\(\)/.test(t) || /^`?\$\{(os\.)?tmpdir\(\)\}/.test(t)) return true;
  const v = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(\/[^\s]*)?$/.exec(t) ?? /^([A-Za-z_$][\w$]*)$/.exec(t); // $VAR (sh) or VAR (js)
  if (v) {
    const name = v[1];
    const assigns = [...script.matchAll(new RegExp(`(?:^|[\\s;(])(?:const\\s+|let\\s+|var\\s+|local\\s+|export\\s+)?${name.replace(/\$/g, '\\$')}\\s*=\\s*([^\\n;]+)`, 'g'))].map((m) => m[1].trim());
    return assigns.length > 0 && assigns.every((a) => /^["'`]?(\/tmp(\/|["'`]|$)|\$\(mktemp\b|\$\{?TMPDIR\}?|`?\$\(mktemp)/.test(a) || /\b(os\.)?tmpdir\(\)|mkdtempSync\(/.test(a));
  }
  return false;
}

/** Lenient target check for markdown snippets: writes into the app tree or app source files. */
function isAppTarget(target: string): boolean {
  const t = target.replace(/^["'`]|["'`]$/g, '');
  if (/^\/(tmp|dev)\//.test(t)) return false;
  return /(^|\/)(frontend|backend|src|workspace)(\/|$)/.test(t) || /\.(?:[cm]?[jt]sx?|css|html?|sql)$/.test(t);
}

// ---------------------------------------------------------------------------
// Layer 3: similarity (winnowed k-gram fingerprints)
// ---------------------------------------------------------------------------

const KEEP_WORDS = new Set(
  (
    'const let var function return if else for while do async await import export from default new class extends try catch finally throw ' +
    'true false null undefined typeof instanceof of in switch case break continue this ' +
    // framework / platform APIs (cannot be renamed)
    'require module exports express Router json status send listen use get post put patch delete prepare run all exec pragma Database ' +
    'useState useEffect useRef useMemo useCallback useReducer React createRoot render fetch then method headers body JSON stringify parse ' +
    'Number String Boolean parseInt isInteger trim length map filter find push slice splice setTimeout preventDefault target value ' +
    'className onClick onChange onSubmit onKeyDown key checked disabled aria role type htmlFor console log error'
  ).split(/\s+/),
);

/** Tokens of code or text: identifiers, numbers, string literals, single punctuation; comments dropped. */
export function tokenize(text: string): { exact: string; norm: string }[] {
  const out: { exact: string; norm: string }[] = [];
  // Backticks are plain punctuation (template literals are tokenized like code on both sides), so a
  // stray backtick or a markdown fence cannot swallow a whole file into one "string" token.
  const re = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[A-Za-z_$][\w$-]*|\d+(?:\.\d+)?|[^\s\w]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const t = m[0];
    if (t.startsWith('//') || t.startsWith('/*')) {
      // Keep URLs like http://... (only drop real comments: start of line or after whitespace/punctuation)
      const prev = text[m.index - 1];
      if (t.startsWith('//') && prev === ':') {
        out.push({ exact: '/', norm: '/' }, { exact: '/', norm: '/' });
        re.lastIndex = m.index + 2;
      }
      continue;
    }
    if (/^["']/.test(t)) out.push({ exact: t.slice(1, -1).toLowerCase().replace(/\s+/g, ' '), norm: 'S' });
    else if (/^[A-Za-z_$]/.test(t)) out.push({ exact: t.toLowerCase(), norm: KEEP_WORDS.has(t) ? t : 'v' });
    else out.push({ exact: t, norm: t });
  }
  return out;
}

/** FNV-1a 32-bit. */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Normalized channel: collapse runs of renamed identifiers ('v v v' → 'v'), keep the rest. */
function normSeq(tokens: { norm: string }[]): string[] {
  return normSeqSpans(tokens).seq;
}

/** normSeq plus, per normalized token, how many original tokens it stands for. */
function normSeqSpans(tokens: { norm: string }[]): { seq: string[]; span: number[] } {
  const seq: string[] = [];
  const span: number[] = [];
  for (const t of tokens) {
    if (t.norm === 'v' && seq[seq.length - 1] === 'v') span[span.length - 1]++;
    else {
      seq.push(t.norm);
      span.push(1);
    }
  }
  return { seq, span };
}

/** Low-information normalized k-grams (prose-like: only identifiers and , . : ;) are ignored. */
function informative(gram: string[]): boolean {
  const distinct = new Set(gram.filter((t) => t !== 'v' && t !== ',' && t !== '.' && t !== ':' && t !== ';' && t !== '-'));
  return distinct.size >= 3;
}

/** All k-gram hashes with their start index. */
function kgrams(seq: string[], k: number, filter?: (g: string[]) => boolean): { h: number; i: number }[] {
  const out: { h: number; i: number }[] = [];
  for (let i = 0; i + k <= seq.length; i++) {
    const g = seq.slice(i, i + k);
    if (filter && !filter(g)) continue;
    out.push({ h: fnv(g.join('\u0001')), i });
  }
  return out;
}

/** Winnowing: the minimum hash of every window of w consecutive k-grams. */
export function winnow(hashes: number[], w: number): number[] {
  if (hashes.length <= w) return [...new Set(hashes)];
  const out = new Set<number>();
  for (let i = 0; i + w <= hashes.length; i++) {
    let min = hashes[i];
    for (let j = i + 1; j < i + w; j++) if (hashes[j] <= min) min = hashes[j];
    out.add(min);
  }
  return [...out];
}

export interface Fingerprints {
  exact: number[];
  norm: number[];
}

/** Winnowed fingerprints of a text in both channels. */
export function fingerprint(text: string, all = false): Fingerprints {
  const toks = tokenize(text);
  const exactSeq = toks.map((t) => t.exact);
  const normS = normSeq(toks);
  const e = kgrams(exactSeq, SIMILARITY.k).map((x) => x.h);
  const n = kgrams(normS, SIMILARITY.k, informative).map((x) => x.h);
  return all ? { exact: [...new Set(e)], norm: [...new Set(n)] } : { exact: winnow(e, SIMILARITY.window), norm: winnow(n, SIMILARITY.window) };
}

interface Corpus {
  exact: Map<number, number>; // hash → corpus file index
  norm: Map<number, number>;
  files: string[];
  allow: { exact: Set<number>; norm: Set<number> };
}

interface CacheFile {
  version: number;
  files: Record<string, { size: number; mtimeMs: number; exact: number[]; norm: number[] }>;
}
const CACHE_VERSION = 1;
const allFingerprintCache = new Map<string, Fingerprints>(); // allow-list (all k-grams), per process

function listCorpusFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!CORPUS_SKIP_DIRS.has(e.name)) walk(p);
      } else if (e.isFile() && CORPUS_EXT_RE.test(e.name) && !/\.min\.|\.d\.ts$/.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** Every <runsDir>/<run>/app directory (minus runs of excluded config hashes). */
function snapshotDirs(runsDir: string, excludeHashes: Set<string>): string[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => {
      if (!excludeHashes.size) return true;
      try {
        const h = JSON.parse(readFileSync(join(runsDir, e.name, 'run.json'), 'utf8')).configHash;
        return !excludeHashes.has(h);
      } catch {
        return true;
      }
    })
    .map((e) => join(runsDir, e.name, 'app'))
    .filter((d) => existsSync(d));
}

function loadCorpus(opts: GuardOptions): Corpus {
  const c = opts.corpus || {};
  const runsDir = c.runsDir ?? join(resultsDir(), 'runs');
  const roots = [...snapshotDirs(runsDir, new Set(opts.excludeConfigHashes ?? [])), c.referenceAppDir ?? join(REPO_ROOT, 'evaluator', 'reference-app'), ...(c.extraDirs ?? [])];
  const cachePath = opts.cacheFile === false ? null : opts.cacheFile ?? join(resultsDir(), '.cache', 'config-guard-fingerprints.json');
  let cache: CacheFile = { version: CACHE_VERSION, files: {} };
  if (cachePath && existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as CacheFile;
      if (parsed.version === CACHE_VERSION && parsed.files) cache = parsed;
    } catch {
      /* rebuild */
    }
  }
  let dirty = false;
  const corpus: Corpus = { exact: new Map(), norm: new Map(), files: [], allow: { exact: new Set(), norm: new Set() } };
  const seen = new Set<string>();
  for (const root of roots) {
    for (const file of listCorpusFiles(root)) {
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      if (st.size > SIMILARITY.maxCorpusFileBytes) continue;
      seen.add(file);
      let fp = cache.files[file];
      if (!fp || fp.size !== st.size || fp.mtimeMs !== st.mtimeMs) {
        const f = fingerprint(readFileSync(file, 'utf8'));
        fp = { size: st.size, mtimeMs: st.mtimeMs, exact: f.exact, norm: f.norm };
        cache.files[file] = fp;
        dirty = true;
      }
      const idx = corpus.files.push(relative(REPO_ROOT, file).split('\\').join('/')) - 1;
      for (const h of fp.exact) if (!corpus.exact.has(h)) corpus.exact.set(h, idx);
      for (const h of fp.norm) if (!corpus.norm.has(h)) corpus.norm.set(h, idx);
    }
  }
  for (const f of Object.keys(cache.files))
    if (!seen.has(f) && !existsSync(f)) {
      delete cache.files[f];
      dirty = true;
    }
  if (cachePath && dirty) {
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      const tmp = `${cachePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(cache));
      renameSync(tmp, cachePath);
    } catch {
      /* cache is an optimisation only */
    }
  }
  // Allow-list: k-grams of the starter and the frozen spec (all k-grams, not winnowed).
  const allowDirs = c.allowDirs ?? [join(REPO_ROOT, 'benchmark', 'starter'), join(REPO_ROOT, 'benchmark', 'spec')];
  for (const d of allowDirs) {
    if (!existsSync(d)) continue;
    const files = statSync(d).isDirectory() ? listAllowFiles(d) : [d];
    for (const f of files) {
      const key = `${f}:${statSync(f).mtimeMs}`;
      let fp = allFingerprintCache.get(key);
      if (!fp) {
        fp = fingerprint(readFileSync(f, 'utf8'), true);
        allFingerprintCache.set(key, fp);
      }
      for (const h of fp.exact) corpus.allow.exact.add(h);
      for (const h of fp.norm) corpus.allow.norm.add(h);
    }
  }
  return corpus;
}

function listAllowFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!CORPUS_SKIP_DIRS.has(e.name)) walk(p);
      } else if (e.isFile() && /\.(?:[cm]?[jt]sx?|css|html?|md|ya?ml|json)$/i.test(e.name) && e.name !== 'package-lock.json' && statSync(p).size < 512 * 1024) out.push(p);
    }
  };
  walk(root);
  return out;
}

interface Match {
  corpusFile: string;
  coveredTokens: number;
  coverage: number;
  channel: 'exact' | 'norm';
}

/** Coverage of a text's tokens by k-grams present in the corpus (best channel). */
function matchAgainst(text: string, corpus: Pick<Corpus, 'exact' | 'norm' | 'files' | 'allow'>): Match | null {
  const toks = tokenize(text);
  if (toks.length < SIMILARITY.k) return null;
  let best: Match | null = null;
  for (const channel of ['exact', 'norm'] as const) {
    const ns = channel === 'norm' ? normSeqSpans(toks) : null;
    const seq = ns ? ns.seq : toks.map((t) => t.exact);
    const grams = kgrams(seq, SIMILARITY.k, channel === 'norm' ? informative : undefined);
    const covered = new Uint8Array(seq.length);
    const perFile = new Map<number, number>();
    const index = corpus[channel];
    const allow = corpus.allow[channel];
    for (const g of grams) {
      if (allow.has(g.h)) continue;
      const f = index.get(g.h);
      if (f === undefined) continue;
      perFile.set(f, (perFile.get(f) ?? 0) + 1);
      for (let j = g.i; j < g.i + SIMILARITY.k; j++) covered[j] = 1;
    }
    // Covered ORIGINAL tokens (a collapsed identifier run counts as the tokens it stands for).
    let coveredTokens = 0;
    for (let j = 0; j < covered.length; j++) if (covered[j]) coveredTokens += ns ? ns.span[j] : 1;
    if (!coveredTokens) continue;
    const ratio = coveredTokens / toks.length;
    const top = [...perFile.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const cand: Match = { corpusFile: corpus.files[top], coveredTokens, coverage: ratio, channel };
    // A channel that exceeds its threshold wins; otherwise prefer exact unless renaming hides clearly more.
    if (!best || (exceedsSimilarity(cand) && !exceedsSimilarity(best)) || (exceedsSimilarity(cand) === exceedsSimilarity(best) && coveredTokens > best.coveredTokens * 1.1)) best = cand;
  }
  return best;
}

/** Similarity of config files against one directory (uncached; used for the post-run snapshot check). */
export function similarityAgainstDir(files: Record<string, string>, dir: string): { configFile: string; appFile: string; matched: number; ratio: number; channel: 'exact' | 'norm'; exceeds: boolean } | null {
  const corpus: Corpus = { exact: new Map(), norm: new Map(), files: [], allow: loadCorpus({ corpus: { runsDir: '/nonexistent', referenceAppDir: '/nonexistent' }, cacheFile: false }).allow };
  for (const f of listCorpusFiles(dir)) {
    if (statSync(f).size > SIMILARITY.maxCorpusFileBytes) continue;
    const fp = fingerprint(readFileSync(f, 'utf8'));
    const idx = corpus.files.push(relative(dir, f).split('\\').join('/')) - 1;
    for (const h of fp.exact) if (!corpus.exact.has(h)) corpus.exact.set(h, idx);
    for (const h of fp.norm) if (!corpus.norm.has(h)) corpus.norm.set(h, idx);
  }
  let best: { configFile: string; appFile: string; matched: number; ratio: number; channel: 'exact' | 'norm'; exceeds: boolean } | null = null;
  for (const [file, content] of Object.entries(files)) {
    const m = matchAgainst(content, corpus);
    if (!m) continue;
    const ex = exceedsSimilarity(m);
    if (!best || (ex && !best.exceeds) || (ex === best.exceeds && m.coveredTokens > best.matched))
      best = { configFile: file, appFile: m.corpusFile, matched: m.coveredTokens, ratio: round(m.coverage), channel: m.channel, exceeds: ex };
  }
  return best;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** Channel-specific similarity thresholds (see SIMILARITY). */
export function exceedsSimilarity(m: { coveredTokens: number; coverage: number; channel: 'exact' | 'norm' }): boolean {
  const [abs, forRatio] = m.channel === 'exact' ? [SIMILARITY.minCoveredTokens, SIMILARITY.minCoveredTokensForRatio] : [SIMILARITY.minCoveredTokensRenamed, SIMILARITY.minCoveredTokensForRatioRenamed];
  return m.coveredTokens >= abs || (m.coverage >= SIMILARITY.minCoverage && m.coveredTokens >= forRatio);
}

// ---------------------------------------------------------------------------
// Runtime audit (after each claude-code coding run)
// ---------------------------------------------------------------------------

/** Files a bin script may legitimately touch under /workspace (databases, logs, build caches). */
const APP_SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?|css|scss|less|html?|sql|vue|svelte)$/i;

/**
 * Build the run's ConfigRunAudit from the in-container bin audit log, the stream's hook events and the
 * app snapshot. flagged = a bin script created/modified app source under /workspace, or the snapshot
 * reproduces config content beyond the similarity thresholds.
 */
export function auditCodingRun(opts: {
  config: AgentConfig;
  invocations: BinInvocation[];
  malformedLogLines?: number;
  logMissing?: boolean;
  hookCounts: Record<string, number>;
  appDir?: string;
}): ConfigRunAudit {
  const binCounts: Record<string, number> = {};
  const writes = new Set<string>();
  for (const inv of opts.invocations) {
    binCounts[inv.script] = (binCounts[inv.script] ?? 0) + 1;
    for (const f of inv.changedFiles) if (APP_SOURCE_EXT_RE.test(f)) writes.add(f);
  }
  const reasons: string[] = [];
  const notes = ['the bin audit log lives in the agent-writable /tmp: it is evidence, not proof of absence'];
  if (writes.size) reasons.push(`bin scripts created/modified app source: ${[...writes].slice(0, 10).join(', ')}`);
  if (opts.logMissing && opts.config.bin?.length) notes.push('the bin audit log was missing (no bin script ran, or the log was removed)');
  if (opts.malformedLogLines) notes.push(`${opts.malformedLogLines} malformed audit log line(s)`);
  let snapshotOverlap: ConfigRunAudit['snapshotOverlap'] = null;
  if (opts.appDir && existsSync(opts.appDir)) {
    try {
      snapshotOverlap = similarityAgainstDir(configFilesOf(opts.config), opts.appDir);
      if (snapshotOverlap?.exceeds)
        reasons.push(`app snapshot reproduces config content: ${snapshotOverlap.matched} tokens of ${snapshotOverlap.configFile} found in ${snapshotOverlap.appFile}`);
    } catch (e) {
      notes.push(`snapshot similarity check failed: ${(e as Error).message}`);
    }
  }
  return { binInvocations: opts.invocations, binCounts, binSourceWrites: [...writes], hookCounts: opts.hookCounts, snapshotOverlap, flagged: reasons.length > 0, reasons, notes };
}

/** sha256 of a guard verdict input (for logs). */
export function filesDigest(files: Record<string, string>): string {
  const h = createHash('sha256');
  for (const k of Object.keys(files).sort()) h.update(k + '\0' + files[k] + '\0');
  return h.digest('hex').slice(0, 16);
}
