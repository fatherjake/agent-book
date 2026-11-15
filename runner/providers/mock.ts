/**
 * MOCK provider — FOR INFRASTRUCTURE TESTS ONLY.
 *
 * It does not call any model. It replays a script of responses regardless of input, with
 * synthetic usage flagged `usageEstimated: true` and zero cost. Every result produced with it is
 * flagged `usedMockProvider` by the runner and can never be reported as a real benchmark result.
 *
 * Scripts:
 *  - { type: 'default' }                     write /workspace/MOCK_RUN.txt, then finish
 *  - { type: 'steps', steps }                arbitrary scripted turns
 *  - { type: 'write-files-from-dir', dir }   write every text file under `dir` into /workspace via
 *                                            write_file calls (optionally run a command), then finish
 *  - { type: 'loop', toolCall }              never finishes (for limit tests)
 *
 * Calls with purpose other than 'agent-turn' (compaction, summarize-tool-output) get a synthetic
 * summary and do NOT consume script steps.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ContentBlock, ModelProvider, ModelRequest, ModelResponse } from '../types.js';

export interface MockStep {
  content: ContentBlock[];
  stopReason?: ModelResponse['stopReason'];
  /** Throw this error message instead of responding. */
  error?: string;
}

export type MockScript =
  | { type: 'default' }
  | { type: 'steps'; steps: MockStep[] }
  | {
      type: 'write-files-from-dir';
      dir: string;
      /** write_file calls per assistant turn (default 8). */
      filesPerTurn?: number;
      /** Command(s) to run via run_command after writing, e.g. 'npm run build'. */
      commands?: string[];
      /** Directory/file names to skip (default node_modules, dist, data, .git, *.db). */
      exclude?: string[];
      /** Destination root inside the container (default /workspace). */
      destRoot?: string;
    }
  | { type: 'loop'; toolCall?: { name: string; input: Record<string, unknown> } };

const DEFAULT_EXCLUDE = ['node_modules', 'dist', 'data', '.git', '.DS_Store'];

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Collect text files under dir (sorted, deterministic). Binary files are skipped. */
export function collectTextFiles(dir: string, exclude: string[] = DEFAULT_EXCLUDE): { rel: string; content: string }[] {
  const out: { rel: string; content: string }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (exclude.includes(name) || name.endsWith('.db')) continue;
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        const buf = readFileSync(full);
        if (!isBinary(buf)) out.push({ rel: relative(dir, full).split('\\').join('/'), content: buf.toString('utf8') });
      }
    }
  };
  walk(dir);
  return out;
}

let idCounter = 0;
const toolUse = (name: string, input: Record<string, unknown>): ContentBlock => ({
  type: 'tool_use',
  id: `toolu_mock_${(++idCounter).toString(36)}`,
  name,
  input,
});

export function buildSteps(script: MockScript): MockStep[] {
  switch (script.type) {
    case 'default':
      return [
        {
          content: [
            { type: 'text', text: '[MOCK] Writing a trivial file.' },
            toolUse('write_file', { path: '/workspace/MOCK_RUN.txt', content: 'written by the mock provider (infrastructure test)\n' }),
          ],
          stopReason: 'tool_use',
        },
        { content: [{ type: 'text', text: '[MOCK] Done.' }], stopReason: 'end_turn' },
      ];
    case 'steps':
      return script.steps;
    case 'write-files-from-dir': {
      const files = collectTextFiles(script.dir, script.exclude ?? DEFAULT_EXCLUDE);
      const per = Math.max(1, script.filesPerTurn ?? 8);
      const root = (script.destRoot ?? '/workspace').replace(/\/+$/, '');
      const steps: MockStep[] = [];
      for (let i = 0; i < files.length; i += per) {
        steps.push({
          content: [
            { type: 'text', text: `[MOCK] Writing files ${i + 1}-${Math.min(i + per, files.length)} of ${files.length}.` },
            ...files.slice(i, i + per).map((f) => toolUse('write_file', { path: `${root}/${f.rel}`, content: f.content })),
          ],
          stopReason: 'tool_use',
        });
      }
      for (const cmd of script.commands ?? []) {
        steps.push({ content: [toolUse('run_command', { command: cmd, timeout_sec: 600 })], stopReason: 'tool_use' });
      }
      steps.push({ content: [{ type: 'text', text: `[MOCK] Wrote ${files.length} files.` }], stopReason: 'end_turn' });
      return steps;
    }
    case 'loop':
      return [];
  }
}

function charsOf(req: ModelRequest): number {
  let n = req.system.length + JSON.stringify(req.tools ?? []).length;
  for (const m of req.messages)
    for (const b of m.content) {
      if (b.type === 'text') n += b.text.length;
      else if (b.type === 'tool_result') n += b.content.length;
      else if (b.type === 'tool_use') n += JSON.stringify(b.input).length;
      else n += 6400; // image ≈ 1600 tokens
    }
  return n;
}

export class MockProvider implements ModelProvider {
  readonly name = 'mock';
  readonly isMock = true;
  /** Every request received (for test assertions). */
  readonly requests: ModelRequest[] = [];
  private steps?: MockStep[];
  private idx = 0;

  constructor(private readonly script: MockScript = { type: 'default' }) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push({ ...req, messages: [...req.messages] });
    if (req.signal?.aborted) throw new Error('aborted');
    let step: MockStep;
    if (req.purpose && req.purpose !== 'agent-turn') {
      step = { content: [{ type: 'text', text: `[MOCK ${req.purpose}] synthetic summary: work in progress.` }], stopReason: 'end_turn' };
    } else if (this.script.type === 'loop') {
      const tc = this.script.toolCall ?? { name: 'run_command', input: { command: 'echo looping' } };
      step = { content: [toolUse(tc.name, tc.input)], stopReason: 'tool_use' };
    } else {
      this.steps ??= buildSteps(this.script);
      step = this.steps[this.idx++] ?? { content: [{ type: 'text', text: '[MOCK] Script exhausted; finishing.' }], stopReason: 'end_turn' };
    }
    if (step.error) throw new Error(step.error);
    const inputTokens = Math.ceil(charsOf(req) / 4);
    const outputTokens = Math.ceil(JSON.stringify(step.content).length / 4);
    return {
      content: step.content,
      stopReason: step.stopReason ?? (step.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
      usage: {
        provider: 'mock',
        model: req.model,
        inputTokens,
        outputTokens,
        reasoningTokens: 0,
        reasoningIncludedInOutput: true,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: inputTokens + outputTokens,
        costUsd: 0,
        costEstimated: true,
        usageEstimated: true,
        raw: { mock: true, note: 'synthetic usage estimated from character counts (chars/4)' },
      },
    };
  }
}

export function createMockProvider(script?: MockScript): MockProvider {
  return new MockProvider(script);
}
