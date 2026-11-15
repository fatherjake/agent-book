/**
 * Per-run network for the claude-code coding container: its ONLY reachable destination is the
 * host gateway (runner/gateway.ts).
 *
 *   coding container ──(per-run `--internal` network, no gateway/egress)──► forwarder (alias frugal-gateway:8080)
 *   forwarder ──(default bridge)──► host.docker.internal:<gateway port> ──► gateway on host 127.0.0.1
 *
 * The forwarder is a trusted container (same benchmark image, a node one-liner, no app code, read-only,
 * no capabilities) that forwards TCP to exactly one host:port. The coding container has no route
 * anywhere else (an `--internal` network has no default gateway), so e.g. https://example.com fails.
 * Same pattern as the evaluator's proxy (evaluator/app-launcher.ts), in the opposite direction.
 *
 * Docker Desktop (macOS/Windows) forwards host.docker.internal to the host loopback, so the gateway can
 * stay bound to 127.0.0.1. (On plain Linux Docker the gateway would have to listen on the bridge IP; not
 * supported here.)
 */
import { randomBytes } from 'node:crypto';
import { docker } from './sandbox.js';
import { GATEWAY_CONTAINER_ALIAS, GATEWAY_CONTAINER_PORT } from './gateway.js';
import { logger } from './logger.js';

const log = logger('gateway-network');

/** Trusted forwarder: listen on :LISTEN, forward every connection to TARGET_HOST:TARGET_PORT only. */
export function forwarderScript(targetHost: string, targetPort: number, listenPort = GATEWAY_CONTAINER_PORT): string {
  if (!/^[a-z0-9.-]+$/i.test(targetHost) || !Number.isInteger(targetPort)) throw new Error('invalid forwarder target');
  return (
    "const net=require('net');" +
    `net.createServer(c=>{const u=net.connect(${targetPort},'${targetHost}');c.pipe(u).pipe(c);` +
    "u.on('error',()=>c.destroy());c.on('error',()=>u.destroy());})" +
    `.listen(${listenPort},'0.0.0.0');`
  );
}

export interface GatewayNetwork {
  /** Network name to attach the coding container to (pass as createSandbox `network`). */
  network: string;
  /** Gateway URL inside that network, e.g. http://frugal-gateway:8080 */
  gatewayUrl: string;
  forwarderName: string;
  /** Remove forwarder + network. Idempotent, never throws. Call AFTER the coding container is removed. */
  destroy(): Promise<void>;
}

export async function createGatewayNetwork(opts: { runId: string; gatewayPort: number; image: string }): Promise<GatewayNetwork> {
  const safe = opts.runId.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 40);
  const base = `frugal-coding-${safe}-${randomBytes(3).toString('hex')}`;
  const network = `${base}-net`;
  const forwarderName = `${base}-gw`;
  const labels = ['--label', 'frugal.role=coding', '--label', `frugal.runId=${opts.runId}`, '--label', `frugal.createdAt=${new Date().toISOString()}`];
  let destroyed = false;
  const destroy = async () => {
    if (destroyed) return;
    destroyed = true;
    try {
      await docker(['rm', '-f', '-v', forwarderName], { timeoutMs: 60_000 });
      const r = await docker(['network', 'rm', network], { timeoutMs: 30_000 });
      if (r.code !== 0 && !/not found|No such network/i.test(r.stderr)) log.warn('failed to remove coding network', { network, error: r.stderr.trim() });
    } catch (e) {
      log.warn('gateway network destroy failed', { error: String(e) });
    }
  };
  const fail = async (what: string, r: { code: number; stderr: string }) => {
    await destroy();
    throw new Error(`${what} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 1000)}`);
  };

  let r = await docker(['network', 'create', '--internal', ...labels, network], { timeoutMs: 30_000 });
  if (r.code !== 0) await fail('docker network create (coding)', r);
  r = await docker(
    [
      'create',
      '--name', forwarderName,
      ...labels,
      '--label', 'frugal.component=gateway-forwarder',
      '--add-host', 'host.docker.internal:host-gateway',
      '--memory', '128m',
      '--pids-limit', '64',
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--user', 'node',
      '--init',
      opts.image,
      'node', '-e', forwarderScript('host.docker.internal', opts.gatewayPort),
    ],
    { timeoutMs: 60_000 },
  );
  if (r.code !== 0) await fail('docker create (gateway forwarder)', r);
  r = await docker(['network', 'connect', '--alias', GATEWAY_CONTAINER_ALIAS, network, forwarderName], { timeoutMs: 30_000 });
  if (r.code !== 0) await fail('docker network connect (gateway forwarder)', r);
  r = await docker(['start', forwarderName], { timeoutMs: 60_000 });
  if (r.code !== 0) await fail('docker start (gateway forwarder)', r);
  log.debug('gateway network ready', { network, forwarderName, runId: opts.runId });
  return { network, gatewayUrl: `http://${GATEWAY_CONTAINER_ALIAS}:${GATEWAY_CONTAINER_PORT}`, forwarderName, destroy };
}
