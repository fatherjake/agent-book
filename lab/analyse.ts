/**
 * Analysis: turn a session's runs into suggestions (edits to the skill files).
 *
 * The analyst is headless Claude Code on the host with read-only tools (Read, Grep, Glob; no shell, no
 * writes, no web) in a folder that holds the evidence: the current skill files, the task prompts, specs
 * and acceptance criteria, and per run a summary (criteria met and why not, tokens, calls, whether the
 * skills fired), its token profile and its tool calls. It answers with ranked suggestions as JSON.
 *
 * Edits come back as exact find/replace pairs, never as diffs: the lab applies them to the skill files
 * and generates the git diff itself, so every stored diff applies.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { resultsDir } from '../runner/env.js';
import { logger } from '../runner/logger.js';
import { getTask as getBenchmarkTask } from '../runner/tasks.js';
import type { LabDb, RunRow } from './db.js';
import { recipeOf, type LabRepo } from './repos.js';
import { skillsTreeDir } from './skills.js';

const log = logger('lab.analyse');

export const ANALYST_MODEL = process.env.FRUGAL_LAB_ANALYST_MODEL ?? 'claude-opus-5-5';
export const MAX_SUGGESTIONS = 6;

export interface Edit {
  file: string;
  find: string;
  replace: string;
}
export interface RawSuggestion {
  title: string;
  description: string;
  evidence: string;
  edits: Edit[];
}

export const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      maxItems: MAX_SUGGESTIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'description', 'evidence', 'edits'],
        properties: {
          title: { type: 'string', description: 'Short imperative title, under 80 characters.' },
          description: { type: 'string', description: 'Plain English, 2 to 4 sentences: what the change does and why the runs suggest it.' },
          evidence: { type: 'string', description: 'The specific runs, criteria, numbers and trace behaviour behind it.' },
          edits: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file', 'find', 'replace'],
              properties: {
                file: { type: 'string', description: 'Repo-relative path of a skill file, e.g. .agents/skills/saiyan/playbooks/feature.md' },
                find: { type: 'string', description: 'Exact text copied from the current file; must occur exactly once. Empty = append to the end.' },
                replace: { type: 'string', description: 'Replacement text.' },
              },
            },
          },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You analyse how a coding agent used a repository's skill files (its instructions, playbooks and principles) and propose edits to those files that would make agents complete tasks more fully, more cheaply, or both.

Work only from the evidence in the current folder (read README.md first). You can read files; you cannot run anything.

Rules for suggestions:
- Each suggestion is ONE focused change to the skill files, small enough that its effect can be attributed. Rank them by expected value (how often the problem occurs x how much it costs or loses), most valuable first.
- The top three should target different steps or problems, so they can be tested independently.
- Generic, not task-specific: the edits must help on any feature, fix or refactor in this repository. Never mention the specific tasks, their specs, UI texts, file names of the task's feature, or the expected solution.
- Ground every suggestion in evidence from the runs: cite run ids, criteria that were missed, token or call counts, and what the trace shows the agent doing (or not doing).
- Prefer removing or tightening instructions that cost tokens without improving outcomes, and adding instructions only where runs show a gap.
- Edits use exact find/replace text from the current files under skills/ (paths in the answer are repo-relative, without the skills/ prefix).`;

function trunc(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s;
}

/** Tool calls of a run as compact Markdown (input and a slice of the output). */
function toolCallsMd(runDir: string): string {
  const f = join(runDir, 'trace.jsonl');
  if (!existsSync(f)) return '(no trace)\n';
  const out: string[] = [];
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'model_call' && e.text) out.push(`\n**[turn ${e.turn}] agent:** ${trunc(String(e.text).trim(), 600)}`);
    if (e.type === 'tool_call') {
      const input = e.input?.command ?? e.input?.file_path ?? e.input?.skill ?? JSON.stringify(e.input ?? {});
      out.push(`- [turn ${e.turn}] ${e.tool}${e.isError ? ' (ERROR)' : ''}: \`${trunc(String(input).replace(/`/g, "'"), 400)}\` → ${e.returnedChars ?? 0} chars${e.output ? `: ${trunc(String(e.output).replace(/\s+/g, ' '), 300)}` : ''}`);
    }
  }
  return out.join('\n') + '\n';
}

function runSummaryMd(r: RunRow, criteria: { id: string; label: string }[]): string {
  const lines = [
    `# Run ${r.id}`,
    '',
    `- task: ${r.taskId} · status: ${r.status}${r.error ? ` (${r.error})` : ''}`,
    `- tokens: ${r.tokens} · cost: $${r.costUsd.toFixed(3)} · time: ${Math.round(r.durationMs / 1000)}s`,
    `- used the repo skills: ${r.skillsFired === null ? 'unknown' : r.skillsFired ? 'yes' : 'NO'}`,
    `- acceptance criteria met: ${r.criteriaMet.length}/${criteria.length}`,
    '',
  ];
  for (const c of criteria) {
    const d = r.criteriaDetail[c.id];
    lines.push(`- [${d?.met ? 'x' : ' '}] ${c.label}`);
    if (d && !d.met) for (const ch of d.checks.filter((x) => x.outcome !== 'pass')) lines.push(`    - ${ch.id}: ${ch.outcome}${ch.message ? `: ${trunc(ch.message.split('\n')[0], 300)}` : ''}`);
  }
  return lines.join('\n') + '\n';
}

/** Build the analyst's folder. Returns its path (caller removes it). */
export function buildAnalysisFolder(db: LabDb, sessionId: string, repo: LabRepo, skillDiffs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'frugal-analysis-'));
  const tree = skillsTreeDir(repo.skills, skillDiffs);
  try {
    cpSync(tree, join(dir, 'skills'), { recursive: true, verbatimSymlinks: true });
    rmSync(join(dir, 'skills', '.git'), { recursive: true, force: true });
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
  const runs = db.sessionRuns(sessionId);
  const taskIds = [...new Set(runs.map((r) => r.taskId))];
  for (const id of taskIds) {
    const t = repo.tasks.find((x) => x.id === id)!;
    const bench = getBenchmarkTask(t.benchmarkTask);
    const td = join(dir, 'tasks', id);
    mkdirSync(td, { recursive: true });
    writeFileSync(join(td, 'prompt.md'), recipeOf(repo, db.latestProfile(repo.skills.id)?.activation?.chosenId).wrap(readFileSync(bench.promptPath!, 'utf8')));
    if (existsSync(bench.specPath)) for (const f of readdirSync(bench.specPath)) if (f.endsWith('.md')) cpSync(join(bench.specPath, f), join(td, f));
    writeFileSync(join(td, 'criteria.md'), `# Acceptance criteria (${t.kind})\n\n${t.criteria.map((c) => `- ${c.label}`).join('\n')}\n`);
  }
  for (const [i, r] of runs.entries()) {
    const rd = join(dir, 'runs', `${String(i + 1).padStart(2, '0')}-${r.id}`);
    mkdirSync(rd, { recursive: true });
    const t = repo.tasks.find((x) => x.id === r.taskId)!;
    writeFileSync(join(rd, 'summary.md'), runSummaryMd(r, t.criteria));
    const src = join(resultsDir(), 'runs', r.id);
    if (existsSync(join(src, 'profile.md'))) cpSync(join(src, 'profile.md'), join(rd, 'profile.md'));
    writeFileSync(join(rd, 'tool-calls.md'), toolCallsMd(src));
  }
  const done = runs.filter((r) => r.status === 'done');
  writeFileSync(
    join(dir, 'README.md'),
    `# Analysis of ${sessionId}

A coding agent (Claude Code) worked on the tasks under tasks/ in the repository "${repo.name}", ${done.length} finished runs in total.
The repository's skill files, exactly as the agent saw them, are under skills/ (repo-relative paths: drop the skills/ prefix).
Each task prompt was wrapped like this so the skills fire: see tasks/<task>/prompt.md.

- runs/<n>-<runId>/summary.md: acceptance criteria met and, for missed ones, the failing checks; tokens, time, and whether the agent used the skills. START HERE.
- runs/<n>-<runId>/profile.md: per-call token breakdown, costliest tool outputs, waste signals, timeline.
- runs/<n>-<runId>/tool-calls.md: every tool call the agent made, with a slice of its output.
- tasks/<task>/: the prompt, the spec and the acceptance criteria.

Token cost is dominated by the number of model calls times the context size, so whole calls and large tool outputs that stay in context are the main cost drivers.

Answer with up to ${MAX_SUGGESTIONS} ranked suggestions in the required JSON format.
`,
  );
  return dir;
}

/** Apply find/replace edits to a copy of the skills tree and return the git diff (repo-relative paths). */
export function editsToDiff(repo: LabRepo, skillDiffs: string[], edits: Edit[]): string {
  const tree = skillsTreeDir(repo.skills, skillDiffs);
  try {
    const git = (args: string[]) => execFileSync('git', args, { cwd: tree, encoding: 'utf8' });
    git(['add', '-A']);
    git(['-c', 'user.name=lab', '-c', 'user.email=lab@localhost', 'commit', '-q', '-m', 'base']);
    for (const e of edits) {
      const file = e.file.replace(/^skills\//, '').replace(/^\/+/, '');
      const abs = resolve(tree, file);
      if (relative(tree, abs).startsWith('..')) throw new Error(`edit path escapes the skills: ${e.file}`);
      if (!repo.skills.paths.some((p) => file === p || file.startsWith(p.replace(/\/?$/, '/')))) throw new Error(`${file} is not a skill file`);
      if (!existsSync(abs)) {
        if (e.find) throw new Error(`${file} does not exist`);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, e.replace);
        continue;
      }
      const cur = readFileSync(abs, 'utf8');
      if (!e.find) {
        writeFileSync(abs, cur + (cur.endsWith('\n') ? '' : '\n') + e.replace);
        continue;
      }
      const n = cur.split(e.find).length - 1;
      if (n !== 1) throw new Error(`${file}: the text to replace occurs ${n} times (must be exactly once): ${JSON.stringify(e.find.slice(0, 80))}`);
      writeFileSync(abs, cur.replace(e.find, () => e.replace));
    }
    git(['add', '-A']);
    const diff = git(['diff', '--cached', '--no-color', '--no-ext-diff', 'HEAD']);
    if (!diff.trim()) throw new Error('the edits change nothing');
    return diff;
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

export interface AnalysisResult {
  stored: number;
  rejected: { title: string; reason: string }[];
  tokens: number;
}

/** Run the analyst on a session and store its valid suggestions (rank order). */
export async function analyseSession(db: LabDb, sessionId: string, repo: LabRepo, skillDiffs: string[], o: { signal?: AbortSignal; timeoutSec?: number } = {}): Promise<AnalysisResult> {
  const { startGateway } = await import('../runner/gateway.js');
  const { runClaudeHeadless } = await import('../runner/claude-code.js');
  const outDir = join(resultsDir(), 'lab', 'analysis', sessionId);
  mkdirSync(outDir, { recursive: true });
  const gateway = await startGateway({ role: 'research', usageFile: join(outDir, 'usage.jsonl'), mainModel: ANALYST_MODEL });
  const folder = buildAnalysisFolder(db, sessionId, repo, skillDiffs);
  try {
    const args = [
      '--model', ANALYST_MODEL,
      '--append-system-prompt', SYSTEM_PROMPT,
      '--tools', 'Read,Grep,Glob',
      '--disable-slash-commands',
      '--permission-mode', 'dontAsk',
      '--json-schema', JSON.stringify(ANALYSIS_SCHEMA),
    ];
    const res = await runClaudeHeadless({
      cwd: folder,
      prompt: 'Read README.md, study the runs and the skill files, then answer with your ranked suggestions.',
      gateway,
      args,
      env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000' },
      timeoutSec: o.timeoutSec ?? 1500,
      streamFile: join(outDir, 'analyst-stream.jsonl'),
      signal: o.signal,
    });
    const tokens = gateway.tracker.records().reduce((n, r) => n + r.totalTokens, 0);
    const r = res.result;
    if (!r || r.is_error || r.subtype !== 'success') throw new Error(`analyst failed: ${r ? `${r.subtype}: ${String(r.result ?? '').slice(0, 300)}` : `no result (exit ${res.exitCode}${res.timedOut ? ', timed out' : ''})`}`);
    let payload: any = r.structured_output;
    if (!payload && typeof r.result === 'string') {
      const m = r.result.match(/\{[\s\S]*\}/);
      payload = m ? JSON.parse(m[0]) : null;
    }
    const raw: RawSuggestion[] = Array.isArray(payload?.suggestions) ? payload.suggestions : [];
    writeFileSync(join(outDir, 'suggestions.json'), JSON.stringify(raw, null, 2));
    const rejected: AnalysisResult['rejected'] = [];
    let rank = 0;
    for (const s of raw.slice(0, MAX_SUGGESTIONS)) {
      try {
        const diff = editsToDiff(repo, skillDiffs, s.edits);
        rank++;
        db.addSuggestion({ sessionId, rank, title: s.title.trim(), description: s.description.trim(), evidence: s.evidence.trim(), file: [...new Set(s.edits.map((e) => e.file.replace(/^skills\//, '')))].join(', '), diff });
      } catch (e) {
        rejected.push({ title: s.title, reason: String((e as Error).message ?? e) });
      }
    }
    if (rejected.length) log.warn('analyst suggestions rejected', { sessionId, rejected });
    return { stored: rank, rejected, tokens };
  } finally {
    await gateway.stop().catch(() => undefined);
    rmSync(folder, { recursive: true, force: true });
  }
}
