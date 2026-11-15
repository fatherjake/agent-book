/**
 * The research LLM. Reads the best config + history digest, returns a strict JSON proposal that
 * only touches the whitelisted modification surface. Validated strictly; one retry on invalid output.
 * Every call goes through a TokenTracker with role 'research'.
 */
import type { Effort, Message, ModelProvider, UsageRecord } from '../runner/types.js';
import { TokenTracker } from '../runner/token-tracker.js';
import type { Db } from '../storage/db.js';
import { logger } from '../runner/logger.js';
import {
  APPROVED_CONFIG_FIELDS,
  APPROVED_CONTEXT_FIELDS,
  CLAUDE_CODE_BUILTIN_TOOLS,
  CLAUDE_CODE_ENV_ALLOWLIST,
  CLAUDE_CODE_SETTINGS_DENYLIST,
  TOOL_NAMES,
  validateProposal,
  claudeCodeSurfaceDoc,
  withParentBackend,
  type Proposal,
  type WhitelistOptions,
} from './whitelist.js';

const log = logger('research-agent');

export const DEFAULT_RESEARCH_MODEL = 'claude-sonnet-5-5';

/** Host data the agentic research agent uses to build its workspace (ignored by the simple modes). */
export interface ResearchContext {
  db: Db;
  resultsDir: string;
  configsRoot: string;
  /** Public benchmark spec (default benchmark/spec). */
  specDir?: string;
  verificationRuns?: number;
}

export interface ResearchAgentInput {
  /** Agentic mode only: where to find runs/experiments for the research workspace. */
  context?: ResearchContext;
  bestConfigId: string;
  bestConfigFiles: Record<string, string>;
  history: string;
  /** 1-based index of the candidate experiment being proposed. */
  experimentIndex: number;
  /** For the first N candidate experiments, exactly one major variable may change. */
  singleVariableExperiments: number;
  whitelist: WhitelistOptions;
  experimentId?: string;
}

export interface ProposalResult {
  proposal: Proposal;
  usage: UsageRecord[];
  attempts: number;
  /** Agentic mode: the evidence behind the proposal and the estimated savings (stored with the experiment). */
  research?: { evidence: string; expectedSavings: string };
  /** Agentic mode: what the research workspace contained (for logs). */
  workspace?: { experiments: string[]; runs: string[]; notes: string[]; bytes: number };
}

export interface ResearchAgent {
  propose(input: ResearchAgentInput, signal?: AbortSignal): Promise<ProposalResult>;
}

export class ResearchProposalError extends Error {
  constructor(
    message: string,
    readonly usage: UsageRecord[],
    readonly errors: string[] = [],
    /**
     * Set when the call failed because the Claude subscription hit its usage limit (ISO reset time,
     * or '' when the limit was detected but no reset time is known). The loop then waits and retries
     * instead of counting a proposal failure.
     */
    readonly usageLimitResetAt?: string,
  ) {
    super(message);
    this.name = 'ResearchProposalError';
  }
}

export interface CreateResearchAgentOptions {
  provider: ModelProvider;
  model?: string;
  maxOutputTokens?: number;
  effort?: Effort;
  /** Optional file to append research UsageRecords to (in addition to the DB). */
  usageFile?: string;
}

export function buildSystemPrompt(whitelist: WhitelistOptions): string {
  return whitelist.backend === 'claude-code' ? buildClaudeCodeSystemPrompt(whitelist) : buildApiSystemPrompt(whitelist);
}

const OBJECTIVE = `OBJECTIVE
The coding agent builds a full-stack todo app (React/Vite + Express + better-sqlite3) from a starter repo inside an isolated container, following a written spec and a reference design image. A hidden evaluator checks the result (API tests, browser scenarios, persistence, visual similarity >= threshold). Your goal: find configurations that pass ALL mandatory checks on EVERY run while using FEWER coding-agent tokens (median total tokens over repeated runs). A low-token config that fails any check is worthless. Reliability matters more than a lucky run.`;

const OUTPUT_RULES = `OUTPUT
Reply with ONLY one JSON object (no prose, no markdown fences):
{"hypothesis": "<why this change should reduce median tokens while keeping all checks passing>", "changeSummary": "<one or two sentences: exactly what changed>", "files": { ... only the files you change ... }}
File values are complete file contents as JSON strings (escape newlines as \\n), except "config.json" which is a JSON object and file deletions which are null.`;

function buildApiSystemPrompt(whitelist: WhitelistOptions): string {
  const fields = APPROVED_CONFIG_FIELDS.filter((f) => f !== 'claudeCode' && (f !== 'model' || whitelist.allowModelChange));
  return `You are a research agent that optimizes the configuration of an AI coding agent.

${OBJECTIVE}

WHAT YOU MAY CHANGE (nothing else)
- "system-prompt.md": the coding agent's system prompt (full replacement text).
- "skills/<name>.md": skill files appended to the system prompt (full text; null deletes the skill). <name> matches [A-Za-z0-9][A-Za-z0-9_-]*.
- "tools.json": full replacement JSON array of tool configs. Tool names: ${TOOL_NAMES.join(', ')}. Fields: name, enabled, description?, maxOutputChars?, outputMode? ("raw"|"truncate"|"summarize"), timeoutSec? (run_command).
- "config.json": a PARTIAL object with only these fields: ${fields.join(', ')}. context may contain ${APPROVED_CONTEXT_FIELDS.join(', ')} (strategy: "none"|"drop-old-tool-results"|"summarize"). effort: "low"|"medium"|"high"|"xhigh"|"max". designDelivery: "inline-image"|"file-only". null removes a field.
FORBIDDEN: limits, provider, backend, id, parentId${whitelist.allowModelChange ? '' : ', model'}, the benchmark spec, the starter, evaluator tests, thresholds, scoring and token accounting. Proposals touching anything else are rejected automatically. Do not try to game the evaluator; the coding agent cannot see it and you cannot either.

HOW TO WORK
- Read the history. Do not repeat a failed idea unless you change it materially; build on what worked.
- Typical levers: tighter instructions and workflow (plan once, write files in few large edits, avoid re-reading files, verify with one build), skills containing condensed knowledge of the spec/contract, tool output truncation, disabling unneeded tools, context strategy, prompt caching, effort level, inlining vs. not inlining spec files, design delivery.
- Watch the failing checks: a token saving that breaks a check must be fixed before it counts.
- "temperature" has NO effect with the anthropic provider (the API version in use rejects sampling parameters, so it is dropped); do not spend experiments on it. Use "effort" to trade thoroughness for tokens instead.
- Coding-agent tokens include every token of the system prompt and skills on every call, so verbose prompts cost tokens; dense, precise instructions are best.

${OUTPUT_RULES}`;
}

function buildClaudeCodeSystemPrompt(whitelist: WhitelistOptions): string {
  const fields = APPROVED_CONFIG_FIELDS.filter((f) => f !== 'temperature' && (f !== 'model' || whitelist.allowModelChange));
  return `You are a research agent that optimizes the configuration of an AI coding agent.

The coding agent is the real Claude Code CLI (headless, \`claude -p\`) running inside the container, on a Claude subscription. Every token of every model call it makes (main turns, compaction, subagents, background calls) counts.

${OBJECTIVE}

WHAT YOU MAY CHANGE (nothing else)
- "system-prompt.md": text passed to Claude Code as --append-system-prompt (claudeCode.systemPromptMode "append") or as the WHOLE system prompt via --system-prompt ("replace").
- "CLAUDE.md": user-level memory file, loaded into context at the start of EVERY conversation (incl. subagents) when config.json claudeCode.claudeMd is true. Full text; null deletes it (then set claudeMd false).
- "skills/<name>.md": installed as Claude Code skills (~/.claude/skills/<name>/SKILL.md). Only a short description is in context until the agent invokes the Skill tool, then the full text is loaded. Full text; null deletes. <name> matches [A-Za-z0-9][A-Za-z0-9_-]*.
- "config.json": a PARTIAL object with only these fields: ${fields.join(', ')}.
  - claudeCode REPLACES the parent's block as a whole, so always give the complete block: {"systemPromptMode": "append"|"replace", "tools"?: [...], "disallowedTools"?: [...], "settings"?: {...}, "env"?: {...}, "claudeMd"?: boolean}.
    tools = the built-in tool set (--tools; [] disables all, omit = default set); disallowedTools may carry patterns like "Bash(rm *)". Tool names: ${CLAUDE_CODE_BUILTIN_TOOLS.join(', ')}.
    env keys allowed: ${CLAUDE_CODE_ENV_ALLOWLIST.join(', ')} (values: short strings).
    settings: a Claude Code settings object (keys NOT allowed: ${CLAUDE_CODE_SETTINGS_DENYLIST.join(', ')}).
  - effort: "low"|"medium"|"high"|"xhigh"|"max" (--effort). maxOutputTokensPerCall: 0 = Claude Code default, else 256-128000. thinkingBudget (= MAX_THINKING_TOKENS; do not set both). designDelivery: "inline-image"|"file-only". inlineSpecFiles: spec files pasted into the task prompt. context.strategy must stay "none". null removes a field.
- "tools.json" is ignored by this backend (do not send it).
${claudeCodeSurfaceDoc()}
FORBIDDEN: backend, provider, limits, id, parentId${whitelist.allowModelChange ? '' : ', model'}, the benchmark spec, the starter, evaluator tests, thresholds, scoring and token accounting. Proposals touching anything else are rejected automatically. Do not try to game the evaluator; the coding agent cannot see it and you cannot either.

USEFUL LEVERS (Claude Code specifics)
- Fixed overhead: Claude Code's built-in system prompt plus tool definitions is roughly 20-25k tokens and is re-sent on EVERY model call (cached reads still count as tokens). "replace" mode swaps the built-in prompt for system-prompt.md (big saving, but you lose its tool-usage guidance, so the replacement must say how to work); restricting claudeCode.tools to what is needed (e.g. Bash, Read, Write, Edit, Glob) removes tool definitions from every call. Disabling Task/Agent prevents subagents. Skills can only be used while the "Skill" tool is in the tool set: if you drop it, move the needed skill content into the prompt or CLAUDE.md (or delete the skills).
- Subagents (Task/Agent) start new conversations with their own fixed overhead; they rarely pay off for a small app.
- effort: lower effort means less thinking and fewer exploratory calls; too low can cause failures.
- Autocompaction: CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (percent of the context window at which to compact) or DISABLE_AUTO_COMPACT=1. Compaction is itself an expensive call, but a smaller context makes every later call cheaper.
- Output sizes: BASH_MAX_OUTPUT_LENGTH (chars of command output kept, e.g. truncate noisy npm/build logs), CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS, MAX_MCP_OUTPUT_TOKENS, CLAUDE_CODE_MAX_OUTPUT_TOKENS.
- Skills vs CLAUDE.md vs system prompt: CLAUDE.md and system-prompt text are paid on every call; skills cost only their description until used, then their full text stays in context. Put always-needed, dense rules in the prompt; put large reference material (contract details, design token tables) in skills only if the agent reliably invokes them.
- Workflow instructions still matter most: plan once, write each file in one go, avoid re-reading files and repeated builds, verify once.
- Watch the failing checks: a token saving that breaks a check must be fixed before it counts.

${OUTPUT_RULES}`;
}

/**
 * System prompt of the AGENTIC research agent (runs in the research container with Read/Grep/Glob/Bash
 * and Write to /research/scratch). The detailed task, surface and strategy live in /research/README.md.
 */
export function buildAgenticSystemPrompt(o: { single: boolean; maxRuntimeSec?: number; maxTotalTokens?: number }): string {
  return `You are a research agent that optimizes the configuration of an AI coding agent (Claude Code) so it uses fewer tokens while still passing every mandatory check of a hidden evaluator.

You work in a sandboxed container. Everything you may look at is under /research (read-only); /research/README.md explains the task, the modification surface, the constraints and how to read the files. Your only writable directory is /research/scratch (notes, small node/shell analysis scripts, test copies of helper scripts). The starter app is at /workspace (disposable copy) if you need to smoke-test a helper script. There is no internet access. Never run \`claude\`.

Method:
1. Read /research/README.md, then digest.md and the profile.md of the best config's runs.
2. Quantify where the tokens go (per-call cache reads x number of calls, big tool outputs, re-reads, thinking, retries). Use grep / small node scripts on the jsonl files instead of reading them whole.
3. Check experiments/ so you do not repeat a failed idea.
4. Form ONE hypothesis${o.single ? ' (single-variable rule: one major variable, at most 2 files, at most 1 config.json field)' : ''}, build the change, and if it includes a helper script, smoke-test it.
5. Return the proposal through the structured output tool: hypothesis, changeSummary, evidence (cite run ids, call/turn numbers, tool calls and token numbers), expectedSavings (an estimate with arithmetic and the risk), files.

Rules: never put application code (components, routes, SQL, app CSS) in any file — an automatic guard rejects it. Describe how to work, not what code to write. Only touch the documented modification surface.
Budget: ${o.maxRuntimeSec ? `${o.maxRuntimeSec}s` : 'limited time'} and ${o.maxTotalTokens ? `${o.maxTotalTokens.toLocaleString('en-US')} tokens` : 'a limited number of tokens'} for this whole task; every tool call re-sends the conversation, so be economical and submit well before the budget runs out.`;
}

/** First user message of an agentic research session. */
export function buildAgenticTaskPrompt(o: { experimentIndex: number; bestConfigId: string }): string {
  return `Candidate experiment #${o.experimentIndex}. Study the coding sessions in /research (start with /research/README.md) and propose the next configuration change on top of best-config/ (${o.bestConfigId}). Return it with the structured output tool.`;
}

function fence(path: string, content: string): string {
  return `=== ${path} ===\n${content.trimEnd()}\n=== end ${path} ===`;
}

export function buildUserPrompt(input: ResearchAgentInput): string {
  const single = input.experimentIndex <= input.singleVariableExperiments;
  const files = Object.keys(input.bestConfigFiles)
    .sort()
    .map((p) => fence(p, input.bestConfigFiles[p]))
    .join('\n\n');
  return [
    `CURRENT BEST CONFIG (${input.bestConfigId}) — your proposal is applied on top of it:`,
    files,
    '',
    'EXPERIMENT HISTORY:',
    input.history,
    '',
    `THIS IS CANDIDATE EXPERIMENT #${input.experimentIndex}.`,
    single
      ? `RULE FOR THIS EXPERIMENT: change exactly ONE major variable (e.g. one prompt/workflow idea, one skill, one tool setting, or one config field) so the result is interpretable. At most 2 files and at most 1 config.json field.`
      : 'You may combine several changes if the history supports them, but keep the proposal coherent and explainable.',
    'Respond with the JSON object only.',
  ].join('\n');
}

/** Extract the first top-level JSON object from model text (tolerates code fences / stray prose). */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const candidates = [t, fenced?.[1]?.trim()].filter((x): x is string => !!x);
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next */
    }
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
  throw new Error('no JSON object found in response');
}

/** Single-variable rule (early experiments). */
export function checkSingleVariable(p: Proposal): string[] {
  const errs: string[] = [];
  const files = Object.keys(p.files);
  if (files.length > 2) errs.push(`single-variable experiment: changed ${files.length} files (max 2)`);
  const cfg = p.files['config.json'];
  if (cfg && Object.keys(cfg).length > 1) errs.push(`single-variable experiment: changed ${Object.keys(cfg).length} config.json fields (max 1)`);
  return errs;
}

export function createResearchAgent(opts: CreateResearchAgentOptions): ResearchAgent {
  const model = opts.model ?? process.env.RESEARCH_MODEL ?? DEFAULT_RESEARCH_MODEL;
  return {
    async propose(input, signal) {
      const tracker = new TokenTracker({ role: 'research', experimentId: input.experimentId, usageFile: opts.usageFile });
      const provider = tracker.wrap(opts.provider, 'research-proposal');
      input = { ...input, whitelist: withParentBackend(input.whitelist, input.bestConfigFiles) };
      const system = buildSystemPrompt(input.whitelist);
      const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: buildUserPrompt(input) }] }];
      const single = input.experimentIndex <= input.singleVariableExperiments;
      let lastErrors: string[] = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (signal?.aborted) throw new ResearchProposalError('aborted', tracker.records());
        let res;
        try {
          res = await provider.complete({
            model,
            system,
            messages,
            maxOutputTokens: opts.maxOutputTokens ?? 16_000,
            promptCaching: true,
            effort: opts.effort,
            purpose: attempt === 1 ? 'research-proposal' : 'research-proposal-retry',
            signal,
          });
        } catch (e) {
          throw new ResearchProposalError(`research model call failed: ${(e as Error)?.message ?? String(e)}`, tracker.records());
        }
        const text = res.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('');
        let errors: string[];
        try {
          const raw = extractJson(text);
          const v = validateProposal(raw, input.whitelist);
          if (v.ok) {
            errors = single ? checkSingleVariable(v.proposal) : [];
            if (!errors.length) return { proposal: v.proposal, usage: tracker.records(), attempts: attempt };
          } else errors = v.errors;
        } catch (e) {
          errors = [`invalid JSON: ${(e as Error).message}`];
        }
        if (res.stopReason === 'max_tokens') errors.push('response was truncated (max_tokens); make the proposal smaller');
        lastErrors = errors;
        log.warn('invalid research proposal', { attempt, errors });
        messages.push({ role: 'assistant', content: [{ type: 'text', text: text || '(empty)' }] });
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Your proposal was rejected:\n- ${errors.join('\n- ')}\nReturn a corrected proposal as ONE JSON object only, no other text.`,
            },
          ],
        });
      }
      throw new ResearchProposalError(`research agent returned an invalid proposal twice: ${lastErrors.join('; ')}`, tracker.records(), lastErrors);
    },
  };
}
