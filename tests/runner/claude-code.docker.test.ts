/**
 * Docker tests for the claude-code backend (skipped without a docker daemon). Fully offline: the
 * real Claude Code CLI runs inside the coding image, but the gateway forwards to a fake loopback
 * upstream (tests/runner/fake-anthropic.ts), so no model is called and no subscription is used.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docker, createSandbox, isDockerAvailable, type DockerSandbox } from '../../runner/sandbox.js';
import { ensureClaudeCodeImage, type ClaudeCodeImageInfo } from '../../runner/claude-code-image.js';
import { createGatewayNetwork, type GatewayNetwork } from '../../runner/gateway-network.js';
import { startGateway, type GatewayHandle } from '../../runner/gateway.js';
import { CLAUDE_CODE_VERSION } from '../../runner/claude-code.js';
import { loadConfig } from '../../runner/config.js';
import { runCodingAgent } from '../../runner/run.js';
import { sseToolUse, startFakeAnthropic, type FakeAnthropic } from './fake-anthropic.js';

const available = await isDockerAvailable();
const TOKEN = 'sk-ant-oat01-TEST-REAL-TOKEN-for-docker-tests';

async function leftovers(runId: string): Promise<string[]> {
  const c = await docker(['ps', '-aq', '--filter', `label=frugal.runId=${runId}`], { timeoutMs: 30_000 });
  const n = await docker(['network', 'ls', '-q', '--filter', `label=frugal.runId=${runId}`], { timeoutMs: 30_000 });
  return [...c.stdout.toString().split(/\s+/), ...n.stdout.toString().split(/\s+/)].filter(Boolean);
}

describe.skipIf(!available)('claude-code backend (docker, fake upstream)', () => {
  let img: ClaudeCodeImageInfo;
  let fake: FakeAnthropic;
  let specDir: string;
  beforeAll(async () => {
    img = await ensureClaudeCodeImage();
    fake = await startFakeAnthropic({ replyText: 'All done.' });
    specDir = mkdtempSync(join(tmpdir(), 'spec-'));
    writeFileSync(join(specDir, 'requirements.md'), '# Spec\nBuild it.\n');
  }, 900_000);
  afterAll(async () => {
    await fake?.close();
  });

  describe('coding container network', () => {
    let gw: GatewayHandle;
    let net: GatewayNetwork;
    let sb: DockerSandbox;
    const runId = `cctest_net_${Date.now()}`;
    beforeAll(async () => {
      gw = await startGateway({ role: 'coding', runId, upstreamUrl: fake.url, token: TOKEN });
      net = await createGatewayNetwork({ runId, gatewayPort: gw.port, image: img.baseImage });
      sb = await createSandbox({ image: img.image, runId, role: 'coding', network: net.network, home: '/home/node', extraTmpfs: ['/home/node:rw,size=64m,uid=1000,gid=1000,mode=0755'] });
    }, 300_000);
    afterAll(async () => {
      await sb?.destroy();
      await net?.destroy();
      await gw?.stop();
      expect(await leftovers(runId)).toEqual([]);
    });

    it('claude --version matches the host-pinned version', async () => {
      const r = await sb.exec('claude --version');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`${CLAUDE_CODE_VERSION} (Claude Code)`);
    });

    it('cannot reach the internet (https://example.com fails)', async () => {
      const r = await sb.exec(
        `node -e "fetch('https://example.com',{signal:AbortSignal.timeout(8000)}).then(r=>console.log('REACHED',r.status)).catch(e=>console.log('BLOCKED',e.cause?.code||e.name))"`,
        { timeoutSec: 30 },
      );
      expect(r.stdout).toMatch(/BLOCKED/);
      expect(r.stdout).not.toMatch(/REACHED/);
      const ip = await sb.exec(`node -e "require('net').connect(443,'1.1.1.1').on('connect',()=>console.log('REACHED')).on('error',e=>console.log('BLOCKED',e.code)).setTimeout(5000,function(){console.log('BLOCKED timeout');this.destroy()})"`, { timeoutSec: 30 });
      expect(ip.stdout).toMatch(/BLOCKED/);
    });

    it('reaches the gateway through the forwarder', async () => {
      const before = fake.requests.length;
      const r = await sb.exec(
        `node -e "fetch('${net.gatewayUrl}/v1/messages/count_tokens',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.text()).then(t=>console.log('GW',t))"`,
        { timeoutSec: 30 },
      );
      expect(r.stdout).toContain('GW {"input_tokens":4242}');
      expect(fake.requests.length).toBe(before + 1);
    });
  });

  it('runCodingAgent: real Claude Code in the container completes through the gateway', async () => {
    const resultsDir = mkdtempSync(join(tmpdir(), 'ccres-'));
    fake.handler = undefined;
    const before = fake.requests.length;
    const config = loadConfig('baseline');
    const r = await runCodingAgent({ config, seed: 1, resultsDir, specDir, gatewayOptions: { upstreamUrl: fake.url, token: TOKEN }, limitsOverride: { maxRuntimeSec: 180 } });
    expect(r.failureReason).toBeUndefined();
    expect(r).toMatchObject({ status: 'completed', backend: 'claude-code', usedMockProvider: false, configId: 'baseline' });
    expect(r.usage.modelCalls).toBeGreaterThanOrEqual(1);
    expect(r.usage.totalTokens).toBeGreaterThan(0);
    expect(r.usage.costEstimated).toBe(true);
    const msgs = fake.requests.slice(before).filter((q) => q.path.startsWith('/v1/messages?') || q.path === '/v1/messages');
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    for (const q of msgs) expect(q.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(msgs[0].body);
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(JSON.stringify(body.system)).toContain('There is no network access');
    expect(JSON.stringify(body)).toContain('verification-checklist'); // user skill discovered
    expect(JSON.stringify(body.messages)).toContain('<file path=\\"/spec/requirements.md\\">');
    const runDir = join(resultsDir, 'runs', r.runId);
    const usage = readFileSync(join(runDir, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(usage.every((u) => u.role === 'coding' && u.runId === r.runId)).toBe(true);
    const trace = readFileSync(join(runDir, 'trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(trace[0].type).toBe('start');
    expect(trace.some((e) => e.type === 'model_call')).toBe(true);
    expect(trace.at(-1)).toMatchObject({ type: 'end', runStatus: 'completed' });
    expect(existsSync(join(runDir, 'claude-stream.jsonl'))).toBe(true);
    expect(existsSync(join(runDir, 'app', 'package.json'))).toBe(true);
    expect(existsSync(join(runDir, 'app', '.claude'))).toBe(false);
    const runJson = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    expect(runJson.usageCrossCheck.match).toBe(true);
    expect(runJson.usageCrossCheck.gateway.totalTokens).toBe(r.usage.totalTokens);
    expect(await leftovers(r.runId)).toEqual([]);
  }, 300_000);

  it('runCodingAgent: gateway maxModelCalls ends the run as limit_exceeded', async () => {
    const resultsDir = mkdtempSync(join(tmpdir(), 'ccres-'));
    let n = 0;
    fake.handler = (req, res) => {
      if (!req.path.startsWith('/v1/messages?') && req.path !== '/v1/messages') return false;
      const body = JSON.parse(req.body || '{}');
      if (body.stream !== true) return false;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sseToolUse(body.model, `toolu_loop_${++n}`, 'Bash', { command: 'echo hi', description: 'echo' }));
      return true;
    };
    const config = { ...loadConfig('baseline'), limits: { maxTotalTokens: 3_000_000, maxModelCalls: 3, maxRuntimeSec: 180 } };
    const r = await runCodingAgent({ config, seed: 1, resultsDir, specDir, gatewayOptions: { upstreamUrl: fake.url, token: TOKEN } });
    fake.handler = undefined;
    expect(r.status).toBe('limit_exceeded');
    expect(r.failureReason).toMatch(/maxModelCalls \(3\) reached/);
    expect(r.usage.modelCalls).toBeLessThanOrEqual(4); // count_tokens records excluded from the limit
    expect(r.toolCalls).toBeGreaterThanOrEqual(2);
    expect(await leftovers(r.runId)).toEqual([]);
  }, 300_000);

  it('runCodingAgent: a subscription usage limit gives infra_error / usage_limit with the reset time', async () => {
    const resultsDir = mkdtempSync(join(tmpdir(), 'ccres-'));
    const reset = Math.floor(Date.now() / 1000) + 3600;
    fake.handler = (req, res) => {
      if (!req.path.startsWith('/v1/messages')) return false;
      res.writeHead(429, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(reset) });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }));
      return true;
    };
    const r = await runCodingAgent({ config: loadConfig('baseline'), seed: 1, resultsDir, specDir, gatewayOptions: { upstreamUrl: fake.url, token: TOKEN }, limitsOverride: { maxRuntimeSec: 180 } });
    fake.handler = undefined;
    expect(r.status).toBe('infra_error');
    expect(r.failureReason).toBe('usage_limit');
    expect(r.usageLimitResetAt).toBe(new Date(reset * 1000).toISOString());
    expect(await leftovers(r.runId)).toEqual([]);
  }, 300_000);
});
