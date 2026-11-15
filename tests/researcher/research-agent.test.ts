// Research agent tests with a FAKE (scripted) model provider. No real model is called.
import { describe, expect, it } from 'vitest';
import type { ModelProvider, ModelRequest, ModelResponse } from '../../runner/types.js';
import { buildUserPrompt, createResearchAgent, extractJson, ResearchProposalError } from '../../researcher/research-agent.js';

function scriptedProvider(texts: string[]): ModelProvider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    name: 'scripted-fake',
    isMock: true,
    requests,
    async complete(req): Promise<ModelResponse> {
      requests.push(req);
      const text = texts[requests.length - 1] ?? '';
      return {
        content: [{ type: 'text', text }],
        stopReason: 'end_turn',
        usage: {
          provider: 'mock',
          model: req.model,
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 0,
          reasoningIncludedInOutput: true,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 150,
          costUsd: 0,
          costEstimated: true,
          usageEstimated: false,
          raw: null,
        },
      };
    },
  };
}

const input = {
  bestConfigId: 'baseline',
  bestConfigFiles: { 'system-prompt.md': 'You are a coding agent.', 'config.json': '{"model":"m"}' },
  history: 'EXPERIMENTS: none yet',
  experimentIndex: 1,
  singleVariableExperiments: 3,
  whitelist: { allowModelChange: false },
  experimentId: 'exp-0002',
};

const good = JSON.stringify({ hypothesis: 'A denser prompt uses fewer tokens', changeSummary: 'rewrote prompt', files: { 'system-prompt.md': 'Dense prompt.' } });

describe('research agent', () => {
  it('returns a validated proposal and research-role usage records', async () => {
    const p = scriptedProvider(['```json\n' + good + '\n```']);
    const agent = createResearchAgent({ provider: p, model: 'claude-sonnet-5-5' });
    const r = await agent.propose(input);
    expect(r.proposal.files['system-prompt.md']).toBe('Dense prompt.');
    expect(r.attempts).toBe(1);
    expect(r.usage).toHaveLength(1);
    expect(r.usage[0].role).toBe('research');
    expect(r.usage[0].experimentId).toBe('exp-0002');
    expect(p.requests[0].model).toBe('claude-sonnet-5-5');
    expect(p.requests[0].system).toContain('FORBIDDEN');
    expect(p.requests[0].temperature).toBeUndefined();
  });

  it('retries once on invalid output, then succeeds', async () => {
    const p = scriptedProvider(['not json at all', good]);
    const r = await createResearchAgent({ provider: p }).propose(input);
    expect(r.attempts).toBe(2);
    expect(r.usage).toHaveLength(2);
    const retryMsg = p.requests[1].messages.at(-1)!.content[0];
    expect(retryMsg.type === 'text' && retryMsg.text).toContain('rejected');
  });

  it('throws ResearchProposalError (with usage) after two invalid outputs, incl. forbidden fields', async () => {
    const bad = JSON.stringify({ hypothesis: 'raise the limits', changeSummary: 'limits', files: { 'config.json': { limits: { maxTotalTokens: 9e9 } } } });
    const p = scriptedProvider([bad, bad]);
    const err = await createResearchAgent({ provider: p }).propose(input).catch((e) => e);
    expect(err).toBeInstanceOf(ResearchProposalError);
    expect(err.usage).toHaveLength(2);
    expect(err.message).toMatch(/limits/);
  });

  it('enforces one variable at a time for early experiments', async () => {
    const multi = JSON.stringify({ hypothesis: 'many changes at once', changeSummary: 'three changes', files: { 'system-prompt.md': 'a', 'tools.json': '[{"name":"read_file","enabled":true}]', 'skills/x.md': 'b' } });
    const err = await createResearchAgent({ provider: scriptedProvider([multi, multi]) }).propose(input).catch((e) => e);
    expect(err).toBeInstanceOf(ResearchProposalError);
    expect(err.message).toMatch(/single-variable/);
    // later experiments may combine changes
    const ok = await createResearchAgent({ provider: scriptedProvider([multi]) }).propose({ ...input, experimentIndex: 4 });
    expect(Object.keys(ok.proposal.files)).toHaveLength(3);
    expect(buildUserPrompt(input)).toContain('exactly ONE major variable');
    expect(buildUserPrompt({ ...input, experimentIndex: 4 })).not.toContain('exactly ONE major variable');
  });

  it('extracts JSON from noisy text', () => {
    expect(extractJson('Here you go: {"a": 1} thanks')).toEqual({ a: 1 });
    expect(() => extractJson('nothing')).toThrow();
  });
});
