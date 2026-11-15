/**
 * MOCK research-agent provider — FOR INFRASTRUCTURE TESTS ONLY.
 *
 * Used by `npm run research -- --research-provider mock`. It calls no model. Every call returns a
 * trivial, whitelist-valid JSON proposal (one new skill file `skills/mock-note-<n>.md`), so the
 * research loop can be exercised end to end (propose → apply → quick run → verify → decide)
 * without an API key. Usage is synthetic (chars/4), flagged `usageEstimated`, and costs $0.
 * Nothing it proposes is a real research idea.
 */
import type { ModelProvider, ModelRequest, ModelResponse } from '../runner/types.js';

export class MockResearchProvider implements ModelProvider {
  readonly name = 'mock';
  readonly isMock = true;
  private calls = 0;

  async complete(req: ModelRequest): Promise<ModelResponse> {
    if (req.signal?.aborted) throw new Error('aborted');
    const n = ++this.calls;
    const proposal = {
      hypothesis: `[MOCK] Infrastructure-test proposal #${n}: adds a trivial skill note. Not a real research hypothesis.`,
      changeSummary: `[MOCK] Added skills/mock-note-${n}.md (one line, no behavioural intent).`,
      files: {
        [`skills/mock-note-${n}.md`]: `# Mock note ${n}\n\n[MOCK] Written by the mock research agent for an infrastructure test.\n`,
      },
    };
    const text = JSON.stringify(proposal);
    let inChars = req.system.length;
    for (const m of req.messages) for (const b of m.content) if (b.type === 'text') inChars += b.text.length;
    const inputTokens = Math.ceil(inChars / 4);
    const outputTokens = Math.ceil(text.length / 4);
    return {
      content: [{ type: 'text', text }],
      stopReason: 'end_turn',
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
        raw: { mock: true, note: 'mock research agent: synthetic usage estimated from character counts (chars/4)' },
      },
    };
  }
}
