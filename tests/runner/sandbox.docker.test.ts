/**
 * Docker-dependent tests. Skipped automatically when the docker daemon is unavailable.
 * Uses the benchmark image via ensureImage() (built on first use).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupAbandonedContainers, createSandbox, docker, ensureImage, isDockerAvailable, type DockerSandbox } from '../../runner/sandbox.js';
import { loadConfig } from '../../runner/config.js';
import { MockProvider } from '../../runner/providers/mock.js';
import { runCodingAgent } from '../../runner/run.js';

const available = await isDockerAvailable();

describe.skipIf(!available)('docker sandbox', () => {
  let img: { image: string; imageId: string; starterHash: string };
  let sb: DockerSandbox;
  const runId = `test_${Date.now()}`;

  beforeAll(async () => {
    img = await ensureImage();
    const specDir = mkdtempSync(join(tmpdir(), 'spec-'));
    writeFileSync(join(specDir, 'requirements.md'), '# Spec\n');
    mkdirSync(join(specDir, 'sub'));
    writeFileSync(join(specDir, 'sub', 'x.bin'), Buffer.from([0, 1, 2, 255]));
    sb = await createSandbox({ image: img.image, imageId: img.imageId, runId, role: 'coding', specDir });
  }, 600_000);

  afterAll(async () => {
    await sb?.destroy();
  });

  it('runs commands as non-root in /workspace with the starter present', async () => {
    const r = await sb.exec('id -u; pwd; test -d node_modules && echo has-modules');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual(['1000', '/workspace', 'has-modules']);
  });

  it('has no network (only loopback)', async () => {
    const r = await sb.exec('ls /sys/class/net');
    const ifaces = r.stdout.trim().split(/\s+/);
    expect(ifaces).toContain('lo');
    expect(ifaces.some((i) => /^(eth|en|wl)/.test(i))).toBe(false);
    const n = await sb.exec(`node -e "fetch('http://1.1.1.1').then(()=>console.log('ONLINE'),()=>console.log('OFFLINE'))"`, { timeoutSec: 30 });
    expect(n.stdout.trim()).toBe('OFFLINE');
  });

  it('read-only root fs, writable /workspace and /tmp, /spec read-only for the agent', async () => {
    expect((await sb.exec('touch /etc/x')).exitCode).not.toBe(0);
    expect((await sb.exec('touch /workspace/ok /tmp/ok')).exitCode).toBe(0);
    expect((await sb.exec('touch /spec/x')).exitCode).not.toBe(0);
    expect((await sb.exec('stat -c %U /spec/requirements.md')).stdout.trim()).toBe('root');
    expect(await sb.readFile('/spec/requirements.md')).toBe('# Spec\n');
    expect((await sb.readFileBuffer('/spec/sub/x.bin')).equals(Buffer.from([0, 1, 2, 255]))).toBe(true);
  });

  it('timeout kills the process group inside the container', async () => {
    const r = await sb.exec('sleep 301 & sleep 302; echo never', { timeoutSec: 2 });
    expect(r.timedOut).toBe(true);
    expect(r.stdout).not.toMatch(/never/);
    expect(r.durationMs).toBeLessThan(15_000);
    const ps = await sb.exec(`for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done`);
    expect(ps.stdout).not.toMatch(/sleep 30[12]/);
  }, 60_000);

  it('writes/reads files (binary safe), lists dirs, copies out without node_modules', async () => {
    await sb.writeFile('/workspace/src/deep/a.txt', 'héllo\n');
    await sb.writeFileBuffer('/workspace/b.bin', Buffer.from([0, 255, 10, 13]));
    expect(await sb.readFile('/workspace/src/deep/a.txt')).toBe('héllo\n');
    expect((await sb.readFileBuffer('/workspace/b.bin')).equals(Buffer.from([0, 255, 10, 13]))).toBe(true);
    const entries = await sb.listDir('/workspace');
    expect(entries).toContain('src/');
    expect(entries).toContain('node_modules/');
    await expect(sb.readFile('/workspace/nope')).rejects.toThrow();
    const out = mkdtempSync(join(tmpdir(), 'out-'));
    await sb.copyOut('/workspace', out);
    expect(readFileSync(join(out, 'src', 'deep', 'a.txt'), 'utf8')).toBe('héllo\n');
    expect(existsSync(join(out, 'package.json'))).toBe(true);
    expect(existsSync(join(out, 'node_modules'))).toBe(false);
    expect(await sb.diskUsageMB()).toBeGreaterThan(1);
  }, 120_000);

  it('container has the isolation flags', async () => {
    const r = await docker(['inspect', '--format', '{{json .HostConfig}}', sb.containerId]);
    const hc = JSON.parse(r.stdout.toString());
    expect(hc.NetworkMode).toBe('none');
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.CapDrop).toEqual(['ALL']);
    expect(hc.SecurityOpt).toContain('no-new-privileges');
    expect(hc.Memory).toBe(2 * 1024 ** 3);
    expect(hc.NanoCpus).toBe(2e9);
    expect(hc.PidsLimit).toBe(512);
    expect(hc.Binds ?? []).toEqual([]);
    expect(hc.Privileged).toBe(false);
  });

  it('cleanupAbandonedContainers removes old frugal containers', async () => {
    const old = await docker(['run', '-d', '--network', 'none', '--label', 'frugal.role=coding', '--label', 'frugal.createdAt=2000-01-01T00:00:00Z', '--label', `frugal.test=${runId}`, img.image, 'sleep', '60']);
    expect(old.code).toBe(0);
    const id = old.stdout.toString().trim();
    const n = await cleanupAbandonedContainers({ olderThanMinutes: 60, label: `frugal.test=${runId}` });
    expect(await cleanupAbandonedContainers({ olderThanMinutes: 60, label: `frugal.runId=${runId}` })).toBe(0);
    expect(n).toBe(1);
    expect((await docker(['inspect', id])).code).not.toBe(0);
    // our fresh sandbox survives
    expect((await docker(['inspect', sb.containerId])).code).toBe(0);
  }, 60_000);

  it('runCodingAgent end-to-end with the mock provider and a real container', async () => {
    const resultsDir = mkdtempSync(join(tmpdir(), 'res-'));
    const r = await runCodingAgent({ config: { ...loadConfig('baseline-api'), provider: 'mock' }, seed: 0, provider: new MockProvider(), resultsDir });
    expect(r.status).toBe('completed');
    expect(r.usedMockProvider).toBe(true);
    const app = join(resultsDir, 'runs', r.runId, 'app');
    expect(readFileSync(join(app, 'MOCK_RUN.txt'), 'utf8')).toMatch(/mock/);
    expect(existsSync(join(app, 'node_modules'))).toBe(false);
    const left = await docker(['ps', '-a', '--filter', `label=frugal.runId=${r.runId}`, '-q']);
    expect(left.stdout.toString().trim()).toBe('');
  }, 300_000);
});
