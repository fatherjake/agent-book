/**
 * Analysis: turn one session into a task brief and ranked suggestions for the repo's agent setup.
 *
 * The analyst is headless Claude Code with read-only tools (Read, Grep, Glob) in a folder of evidence
 * written from the session's telemetry (session.md: the page as text; conversation.md: every turn with
 * its prompt, replies and tool calls). When the project is on disk it can read that too: a git worktree at
 * the commit the session started from, or the folder itself (workspace.ts). No project is fine: it works
 * from the session alone. It answers with JSON (--json-schema): a self-contained brief of the session's
 * main task with checks for what done looks like, and suggestions as exact find/replace edits. Each
 * suggestion's edits are applied to a scratch workspace made the way replays make theirs, to turn them
 * into a diff; ones that don't apply are dropped and listed.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pageText } from '../context.js';
import { sessionDetail, type Item, type SessionDetail } from '../session-detail.js';
import type { TelemetryDb } from '../store.js';
import { applyEdits, diffSince } from './git.js';
import { runHeadless, type HeadlessRun } from './headless.js';
import { LAB_DIR, updateLab, type Edit, type LabState, type Suggestion, type SuggestionKind } from './state.js';
import { describeSource, makeWorkspace, readableProject, resetWorkspace, sourceFor, type Source, type Workspace } from './workspace.js';

export const ANALYST_MODEL = process.env.AGENT_BOOK_ANALYST_MODEL ?? 'claude-opus-5-5';
const MAX_SUGGESTIONS = 6;
const MAX_CONVERSATION = 600_000;
const KINDS: SuggestionKind[] = ['instructions', 'skill', 'process', 'lint', 'hook', 'docs', 'other'];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['brief', 'suggestions'],
  properties: {
    brief: {
      type: 'object',
      additionalProperties: false,
      required: ['task', 'checks'],
      properties: {
        task: { type: 'string', description: 'The session’s main task as one self-contained instruction a fresh agent can carry out alone from the base commit.' },
        checks: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'string' }, description: 'Observable checks a reviewer can judge from the final diff and message.' },
      },
    },
    suggestions: {
      type: 'array',
      maxItems: MAX_SUGGESTIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'kind', 'description', 'evidence', 'expected', 'edits'],
        properties: {
          title: { type: 'string', description: 'Short imperative title, under 80 characters.' },
          kind: { type: 'string', enum: KINDS },
          description: { type: 'string', description: '2 to 4 plain sentences: what the change is and why the session suggests it.' },
          evidence: { type: 'string', description: 'The specific turns, numbers and behaviour behind it (cite turn numbers).' },
          expected: { type: 'string', description: 'What should improve and roughly how much: tokens, cost, time, checks met.' },
          edits: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file', 'find', 'replace'],
              properties: {
                file: { type: 'string', description: 'Repo-relative path, e.g. CLAUDE.md or .claude/skills/testing/SKILL.md.' },
                find: { type: 'string', description: 'Exact text copied from the file at the base commit; must occur exactly once. Empty = append, or create the file.' },
                replace: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You review one Claude Code session and propose changes to the repository's agent setup that would let a future agent do the same kind of work better: fewer tokens and less time for the same result, or a better result.

The evidence is in the current folder: session.md (the session's stats, cost, time and a turn index) and conversation.md (every turn: the prompt, Claude's replies, each tool call and whether it failed). session.md says whether the project's files are available and where; when they are, read its existing agent setup first (CLAUDE.md, AGENTS.md, .claude/ including skills, agents, commands and settings, lint and formatter configs, Makefile / package.json scripts, docs). When they aren't, work from the session alone: the replays start in an empty folder, so suggestions create new setup files (CLAUDE.md, .claude/skills/<name>/SKILL.md, scripts) with an empty "find".

Look for where the session lost time or tokens: rediscovering the codebase, repeated or failed commands, guessing how to build, test or run things, misunderstandings that needed correcting, slow or expensive subagents, permission prompts, long waits, rework after review. Then propose changes of these kinds:
- instructions: CLAUDE.md / AGENTS.md guidance (conventions, where things are, how to verify work)
- skill: a .claude/skills/<name>/SKILL.md the agent can load for a recurring kind of task
- process: a repeatable workflow, script or command (Makefile target, npm script, .claude/commands/)
- lint: a lint, type or format rule that catches a mistake the session made
- hook: a .claude/settings.json hook (e.g. format or check after edits)
- docs: a short doc the agent can read instead of exploring
Rules:
- Every suggestion must be generic: it helps future sessions in this repository, not only this exact task. Never put the task's answer in the setup.
- Keep each change small and concrete. Rank the suggestions by expected impact, most first. Fewer good suggestions beat many weak ones.
- Edits are exact find/replace on the project's files as session.md says they will be at the start of a replay: copy "find" exactly from the file, and it must occur once. To create a file or add to the end, leave "find" empty.
- Also write the brief: the session's main task as one self-contained instruction a fresh agent can do alone, without asking questions, starting from the workspace session.md describes; and 2 to 8 checks a reviewer can judge from the agent's final diff and message. If the task produced no files (an answer, research), the checks can be about the final message. Leave out chit-chat and side requests.`;

const cut = (s: string | null | undefined, n: number) => (!s ? '' : s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s);

/** Every turn in full (cut to a size the analyst can read). */
function conversationText(d: SessionDetail): string {
  const out: string[] = [`# Conversation (${d.turns.length} turns)\n`];
  const items = (list: Item[], depth: number) => {
    const pad = '  '.repeat(depth);
    for (const i of list) {
      if (i.kind === 'response') out.push(`${pad}Claude: ${cut(i.text, 4000)}`);
      else if (i.kind === 'tool') out.push(`${pad}- ${i.name}${i.success ? '' : ' (FAILED)'} ${cut(i.label, 200)} [${Math.round((i.durationMs ?? 0) / 100) / 10}s]${i.input && i.name === 'Bash' ? `\n${pad}  $ ${cut(i.input, 400)}` : ''}`);
      else if (i.kind === 'subagent') {
        out.push(`${pad}- Subagent ${i.agentType ?? ''}: ${i.toolUses ?? '?'} tool calls, ${i.tokens ?? '?'} tokens, ${Math.round((i.durationMs ?? 0) / 1000)}s`);
        items(i.items, depth + 1);
      } else if (i.kind === 'error') out.push(`${pad}! API error: ${i.text}`);
      else if (i.kind === 'compaction') out.push(`${pad}! Context compacted (${i.preTokens} → ${i.postTokens} tokens)`);
      else if (i.kind === 'skill') out.push(`${pad}- Skill loaded: ${i.name}`);
      else if (i.kind === 'mode') out.push(`${pad}! Permission mode ${i.from} → ${i.to}`);
    }
  };
  d.turns.forEach((t, n) => {
    out.push(`\n## Turn ${n + 1} · ${t.ts} · ${Math.round(t.durationMs / 1000)}s · $${t.costUsd.toFixed(2)} · ${t.toolCalls} tool calls`);
    out.push(`${t.promptKind === 'user' ? 'User' : t.promptKind === 'task' ? 'Background task finished' : 'Message'}: ${cut(t.promptKind === 'user' ? t.prompt : t.promptLabel, 6000)}`);
    items(t.items, 0);
  });
  const text = out.join('\n');
  return text.length > MAX_CONVERSATION ? `${text.slice(0, MAX_CONVERSATION / 2)}\n\n… (middle of the conversation left out) …\n\n${text.slice(-MAX_CONVERSATION / 2)}` : text;
}

/** The model a replay should use: the one the session spent most on. */
const mainModel = (d: SessionDetail) => d.byModel[0]?.model ?? 'opus';

/** A budget cap per replay: about what the session cost, within $2–$20. */
const defaultBudget = (d: SessionDetail) => Math.round(Math.min(20, Math.max(2, d.totals.costUsd)) * 100) / 100;

/** What session.md says about the project's files. */
function projectNote(src: Source, readable: string | null): string {
  if (src.kind === 'git') return `The project is a git repository. Its files as they were when the session started (commit ${src.rev}) are in: ${readable}\nReplays start from that commit.`;
  if (src.kind === 'folder') return `The project folder isn't a git repository. Its files as they are now (they may have changed since the session) are in: ${readable}\nReplays start from a copy of it (dependencies and build output left out).`;
  return "No project files are available: the session had no folder, or it's gone. Work from the session alone. Replays start in an empty folder.";
}

/** Start an analysis. Returns the running process, or throws when the session can't be analysed. */
export function startAnalysis(db: TelemetryDb, sessionId: string, onEnd: () => void): HeadlessRun {
  const d = sessionDetail(db, sessionId);
  if (!d) throw new Error('No such session.');
  if (!d.turns.length) throw new Error('This session has no prompts to learn from.');
  const source = sourceFor(db, d);

  const work = join(LAB_DIR(), 'analysis', sessionId);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  // A git project is read at its starting commit; a plain folder is read in place (read-only tools).
  const tree: Workspace | null = source.kind === 'git' ? makeWorkspace(source, `analysis-${sessionId}`) : null;
  const readable = readableProject(source, tree?.dir ?? null);
  writeFileSync(join(work, 'session.md'), `# Session\n\n${projectNote(source, readable)}\n\n${pageText(d)}\n`);
  writeFileSync(join(work, 'conversation.md'), conversationText(d));

  const analystSession = randomUUID();
  updateLab(sessionId, (s) => {
    s.analysis = { status: 'running', startedAt: new Date().toISOString(), sessionId: analystSession, source, sourceLabel: describeSource(source), model: mainModel(d), rejected: [] };
  });

  const run = runHeadless(
    work,
    [
      '--model', ANALYST_MODEL,
      '--session-id', analystSession,
      '--append-system-prompt', SYSTEM_PROMPT,
      '--tools', 'Read,Grep,Glob',
      '--permission-mode', 'dontAsk',
      ...(readable ? ['--add-dir', readable] : []),
      '--json-schema', JSON.stringify(SCHEMA),
    ],
    'Read session.md and conversation.md, study the project if session.md says it is available, then answer with the brief and your ranked suggestions.',
    { timeoutMs: 30 * 60_000 },
  );

  void run.done.then((r) => {
    let check: Workspace | null = null;
    try {
      const payload: any = r.structured ?? (() => {
        const m = r.result.match(/\{[\s\S]*\}/);
        try {
          return m ? JSON.parse(m[0]) : null;
        } catch {
          return null;
        }
      })();
      if (r.isError || !payload?.brief) throw new Error(r.error ?? `The analyst ended with ${r.ending}${r.result ? `: ${cut(r.result, 300)}` : ''}`);
      const suggestions: Suggestion[] = [];
      const rejected: { title: string; reason: string }[] = [];
      // One scratch workspace, made the way replays make theirs: apply, diff, reset, next.
      check = makeWorkspace(source, `check-${sessionId}`);
      for (const raw of (payload.suggestions ?? []).slice(0, MAX_SUGGESTIONS)) {
        const edits: Edit[] = (raw.edits ?? []).map((e: any) => ({ file: String(e.file ?? ''), find: String(e.find ?? ''), replace: String(e.replace ?? '') }));
        try {
          applyEdits(check.dir, edits);
          const { diff } = diffSince(check.dir, check.start);
          if (!diff.trim()) throw new Error('the edits change nothing');
          suggestions.push({
            id: randomUUID().slice(0, 8),
            rank: suggestions.length + 1,
            title: String(raw.title ?? '').trim(),
            kind: KINDS.includes(raw.kind) ? raw.kind : 'other',
            description: String(raw.description ?? '').trim(),
            evidence: String(raw.evidence ?? '').trim(),
            expected: String(raw.expected ?? '').trim(),
            edits,
            diff,
            runs: [],
          });
        } catch (e) {
          rejected.push({ title: String(raw.title ?? ''), reason: String((e as Error).message ?? e) });
        } finally {
          resetWorkspace(check);
        }
      }
      updateLab(sessionId, (s: LabState) => {
        const version = (s.brief?.version ?? 0) + 1;
        s.brief = { version, task: String(payload.brief.task).trim(), checks: (payload.brief.checks ?? []).map((c: unknown) => String(c).trim()).filter(Boolean), budgetUsd: defaultBudget(d), edited: false };
        s.suggestions = suggestions;
        s.baseline = [];
        if (s.analysis) Object.assign(s.analysis, { status: 'done', finishedAt: new Date().toISOString(), costUsd: r.costUsd, rejected });
      });
    } catch (e) {
      updateLab(sessionId, (s) => {
        if (s.analysis) Object.assign(s.analysis, { status: 'failed', finishedAt: new Date().toISOString(), costUsd: r.costUsd, error: String((e as Error).message ?? e) });
      });
    } finally {
      check?.remove();
      tree?.remove();
      onEnd();
    }
  });
  return run;
}
