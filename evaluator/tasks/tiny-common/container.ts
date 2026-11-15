/**
 * Fresh, isolated evaluation container for a tiny task (docs/TASKS.md §3/§4).
 *
 * Topology (same idea as evaluator/app-launcher.ts, no iptables, works on Docker Desktop):
 *
 *   host 127.0.0.1:<port> ──► forwarder container :8080 ──► app container :APP_PORT
 *                             (default bridge + per-run       (per-run `--internal` network only
 *                              internal net)                    → no egress)
 *
 * The app container runs the task's BASE image (no Claude Code) with the sandbox hardening
 * (read-only root, cap-drop ALL, no-new-privileges, uid 1000) and the task's extra volumes/tmpfs.
 * The forwarder is a raw TCP pipe written by the evaluator (never app code), run with the image's
 * own `node` (ES5 syntax, no dependencies). A raw pipe
 * keeps the Host header (127.0.0.1:<port>) intact and passes WebSocket upgrades through untouched.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { containerState, docker, type CmdResult } from '../../docker.js';
import { EvaluatorInfraError } from '../../app-launcher.js';

/** Port the app serves on inside the container (`/opt/frugal/task/app start`). Overridable for tests. */
export const TINY_APP_PORT = Number(process.env.FRUGAL_TINY_APP_PORT ?? 3000);
export const FORWARDER_PORT = 8080;
export const APP_USER = '1000:1000';

export const FORWARDER_SCRIPT = [
  "var net=require('net');",
  "var UH=process.env.UPSTREAM_HOST||'app',UP=+(process.env.UPSTREAM_PORT||3000),LP=+(process.env.LISTEN_PORT||8080);",
  'net.createServer(function(c){',
  'var u=net.connect(UP,UH);',
  "c.on('error',function(){u.destroy();});u.on('error',function(){c.destroy();});",
  'c.pipe(u);u.pipe(c);',
  "}).listen(LP,'0.0.0.0');",
].join('');

export interface SandboxSpec {
  cpus: number;
  memory: string;
  pidsLimit: number;
  extraVolumes?: string[];
  extraTmpfs?: string[];
}

export interface ExecOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  /** Working directory (default /workspace). */
  cwd?: string;
  input?: Buffer;
}

const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 40);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const HARDENING = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', APP_USER];

/** Shell-quote one argument for `sh -c`. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export class TinyEvalContainer {
  private stopped = false;
  private bg: ChildProcess[] = [];
  private logBuf = '';
  private constructor(
    readonly appName: string,
    readonly proxyName: string,
    readonly netName: string,
    /** e.g. http://127.0.0.1:41234 (no trailing slash). */
    readonly url: string,
  ) {}

  appendLog(s: string): void {
    this.logBuf += s;
    if (this.logBuf.length > 600_000) this.logBuf = this.logBuf.slice(-300_000);
  }

  logs(): string {
    return this.logBuf;
  }

  static async launch(opts: { runId: string; image: string; sandbox: SandboxSpec; taskId: string }): Promise<TinyEvalContainer> {
    const suffix = randomBytes(3).toString('hex');
    const base = `frugal-eval-${sanitize(opts.runId)}-${suffix}`;
    const netName = `${base}-net`;
    const appName = `${base}-app`;
    const proxyName = `${base}-proxy`;
    const labels = ['--label', 'frugal.role=eval', '--label', `frugal.runId=${opts.runId}`, '--label', `frugal.task=${opts.taskId}`];
    const cleanup = async () => {
      await docker(['rm', '-f', '-v', appName, proxyName], { timeoutMs: 60_000 });
      await docker(['network', 'rm', netName], { timeoutMs: 30_000 });
    };
    const infra = (what: string, r: CmdResult) =>
      new EvaluatorInfraError(`${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 2000)}`);
    try {
      let r = await docker(['network', 'create', '--internal', ...labels, netName], { timeoutMs: 30_000 });
      if (r.code !== 0) throw infra('docker network create', r);

      const sb = opts.sandbox;
      const args = [
        'create',
        '--name', appName,
        ...labels,
        '--label', 'frugal.component=app',
        '--init',
        '--cpus', String(sb.cpus),
        '--memory', sb.memory,
        '--memory-swap', sb.memory,
        '--pids-limit', String(sb.pidsLimit),
        ...HARDENING,
        '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=2048m',
        '--mount', 'type=volume,dst=/workspace',
        '-e', 'HOME=/tmp',
        '-e', 'CI=1',
        '--network', netName,
        '--network-alias', 'app',
        '-w', '/workspace',
      ];
      for (const t of sb.extraTmpfs ?? []) args.push('--tmpfs', t);
      for (const v of sb.extraVolumes ?? []) args.push('--mount', `type=volume,dst=${v}`);
      args.push(opts.image, 'sleep', 'infinity');
      r = await docker(args, { timeoutMs: 120_000 });
      if (r.code !== 0) throw infra('docker create (app)', r);
      r = await docker(['start', appName], { timeoutMs: 60_000 });
      if (r.code !== 0) throw infra('docker start (app)', r);

      let url = '';
      for (let attempt = 0; attempt < 3 && !url; attempt++) {
        const port = await freePort();
        await docker(['rm', '-f', proxyName], { timeoutMs: 30_000 });
        r = await docker(
          [
            'create',
            '--name', proxyName,
            ...labels,
            '--label', 'frugal.component=proxy',
            '--memory', '128m',
            '--pids-limit', '64',
            ...HARDENING,
            '--tmpfs', '/tmp:rw,noexec,nosuid,size=1m',
            '-e', `UPSTREAM_PORT=${TINY_APP_PORT}`,
            '-e', `LISTEN_PORT=${FORWARDER_PORT}`,
            '-p', `127.0.0.1:${port}:${FORWARDER_PORT}`,
            '--entrypoint', 'node',
            opts.image,
            '-e', FORWARDER_SCRIPT,
          ],
          { timeoutMs: 60_000 },
        );
        if (r.code !== 0) throw infra('docker create (forwarder)', r);
        r = await docker(['network', 'connect', netName, proxyName], { timeoutMs: 30_000 });
        if (r.code !== 0) throw infra('docker network connect (forwarder)', r);
        r = await docker(['start', proxyName], { timeoutMs: 60_000 });
        if (r.code === 0) url = `http://127.0.0.1:${port}`;
        else if (!/already allocated|address already in use/i.test(r.stderr)) throw infra('docker start (forwarder)', r);
      }
      if (!url) throw new EvaluatorInfraError('could not publish a free port for the forwarder');
      return new TinyEvalContainer(appName, proxyName, netName, url);
    } catch (e) {
      await cleanup();
      if (e instanceof EvaluatorInfraError) throw e;
      throw new EvaluatorInfraError(`launching the eval container: ${(e as Error).message}`);
    }
  }

  private execArgs(cmd: string, o: ExecOptions): string[] {
    const args = ['exec', '-i', '-u', APP_USER, '-w', o.cwd ?? '/workspace'];
    const env = o.env ?? {};
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
    args.push(this.appName, 'sh', '-c', cmd);
    return args;
  }

  /** Run a shell command in the app container (as uid 1000, cwd /workspace). Never throws. */
  async exec(cmd: string, o: ExecOptions = {}): Promise<CmdResult> {
    const r = await docker(this.execArgs(cmd, o), { timeoutMs: o.timeoutMs ?? 300_000, input: o.input });
    return r;
  }

  /** Same as exec, but appends the command and its output to the container log. */
  async execLogged(label: string, cmd: string, o: ExecOptions = {}): Promise<CmdResult> {
    const t0 = Date.now();
    this.appendLog(`\n$ [${label}] ${cmd}\n`);
    const r = await this.exec(cmd, o);
    this.appendLog(`${r.stdout}${r.stderr}\n[${label}] exit ${r.code}${r.timedOut ? ' (timed out)' : ''} after ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    return r;
  }

  /** Start a long-running command (e.g. the app server); its output goes to the log. */
  spawnBackground(label: string, cmd: string, o: ExecOptions = {}): { proc: ChildProcess; exited: () => number | null } {
    this.appendLog(`\n$ [${label}] ${cmd} (background)\n`);
    const proc = spawn('docker', this.execArgs(cmd, o), { stdio: ['ignore', 'pipe', 'pipe'] });
    let code: number | null = null;
    proc.stdout?.on('data', (d: Buffer) => this.appendLog(d.toString()));
    proc.stderr?.on('data', (d: Buffer) => this.appendLog(d.toString()));
    proc.on('close', (c) => {
      code = c ?? 1;
      this.appendLog(`\n[${label}] exited with ${code}\n`);
    });
    this.bg.push(proc);
    return { proc, exited: () => code };
  }

  /** Write a file into the container (as uid 1000) via stdin. */
  async writeFile(containerPath: string, content: Buffer | string): Promise<void> {
    const dir = path.posix.dirname(containerPath);
    const r = await this.exec(`mkdir -p ${shq(dir)} && cat > ${shq(containerPath)}`, {
      input: Buffer.isBuffer(content) ? content : Buffer.from(content),
      timeoutMs: 120_000,
    });
    if (r.code !== 0) throw new EvaluatorInfraError(`writing ${containerPath} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  }

  async copyFileIn(hostPath: string, containerPath: string): Promise<void> {
    await this.writeFile(containerPath, fs.readFileSync(hostPath));
  }

  async readFile(containerPath: string): Promise<string | null> {
    const r = await this.exec(`cat ${shq(containerPath)}`, { timeoutMs: 60_000 });
    return r.code === 0 ? r.stdout : null;
  }

  /** Is the app container still running? (false → infra problem or OOM) */
  async state(): Promise<{ running: boolean; oomKilled: boolean } | null> {
    const s = await containerState(this.appName);
    return s ? { running: s.running, oomKilled: s.oomKilled } : null;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const p of this.bg) {
      try {
        p.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    await docker(['rm', '-f', '-v', this.appName, this.proxyName], { timeoutMs: 60_000 });
    await docker(['network', 'rm', this.netName], { timeoutMs: 30_000 });
  }
}
