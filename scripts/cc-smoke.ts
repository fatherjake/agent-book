/**
 * Live smoke test of the claude-code backend (uses the Claude subscription; a handful of cheap calls):
 *   npx tsx scripts/cc-smoke.ts
 * Runs Claude Code in a fresh coding container with the prompt "create /workspace/hello.txt containing
 * hi and stop", through the host gateway (real CLAUDE_CODE_OAUTH_TOKEN swapped in on the host only).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDotEnv, resultsDir } from '../runner/env.js';
import { loadConfig } from '../runner/config.js';
import { runCodingAgent } from '../runner/run.js';
import { hasSubscriptionToken, SETUP_TOKEN_HELP } from '../runner/gateway.js';

loadDotEnv();
if (!hasSubscriptionToken()) {
  console.error(SETUP_TOKEN_HELP);
  process.exit(1);
}
const base = loadConfig('baseline');
const config = { ...base, id: 'baseline', skills: [], inlineSpecFiles: [], designDelivery: 'file-only' as const, limits: { maxTotalTokens: 300_000, maxModelCalls: 12, maxRuntimeSec: 300 } };
const r = await runCodingAgent({ config, seed: 0, taskPrompt: 'Create the file /workspace/hello.txt containing exactly the text hi, then stop. Do not do anything else.' });
const runDir = join(resultsDir(), 'runs', r.runId);
const hello = join(runDir, 'app', 'hello.txt');
console.log(JSON.stringify({ runId: r.runId, status: r.status, failureReason: r.failureReason, durationMs: r.durationMs, toolCalls: r.toolCalls, usage: r.usage, usageCrossCheck: r.usageCrossCheck }, null, 2));
console.log('hello.txt:', existsSync(hello) ? JSON.stringify(readFileSync(hello, 'utf8')) : 'MISSING');
console.log('API-equivalent cost (not billed on a subscription): $' + r.usage.costUsd.toFixed(4));
process.exit(r.status === 'completed' && existsSync(hello) ? 0 : 1);
