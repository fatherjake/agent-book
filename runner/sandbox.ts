/**
 * Docker sandbox, driven through the docker CLI (no dockerode).
 *
 * Isolation (see docs/ARCHITECTURE.md): --network none (coding), non-root user `node`,
 * --cpus/--memory/--pids-limit, --read-only root fs with a writable anonymous volume at
 * /workspace (initialised from the image, so the starter + node_modules are present) and tmpfs
 * /tmp, --cap-drop ALL, no-new-privileges, frugal.* labels, no host mounts, no docker socket.
 * /spec is a root-owned tmpfs filled at creation time, so it is read-only for the agent.
 *
 * Storage: Docker Desktop's overlayfs does not support `--storage-opt size=`. createSandbox tries
 * it when `storageLimitGb` is set and falls back without it; the agent loop additionally enforces a
 * workspace size limit with `du` (see agent.ts, diskLimitMB).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ExecResult, Sandbox } from './types.js';
import { logger } from './logger.js';

export { ensureImage } from '../benchmark/docker/image.js';

const log = logger('sandbox');

// ---------------------------------------------------------------------------
// docker CLI helper
// ---------------------------------------------------------------------------

const MAX_STREAM_BYTES = 1024 * 1024; // keep up to 1 MiB head + 1 MiB tail per stream

class CappedBuffer {
  private head: Buffer[] = [];
  private headLen = 0;
  private tail = Buffer.alloc(0);
  private dropped = 0;
  constructor(private readonly cap = MAX_STREAM_BYTES) {}
  push(chunk: Buffer) {
    if (this.headLen < this.cap) {
      const take = Math.min(this.cap - this.headLen, chunk.length);
      this.head.push(chunk.subarray(0, take));
      this.headLen += take;
      chunk = chunk.subarray(take);
    }
    if (chunk.length === 0) return;
    const combined = Buffer.concat([this.tail, chunk]);
    if (combined.length > this.cap) {
      this.dropped += combined.length - this.cap;
      this.tail = combined.subarray(combined.length - this.cap);
    } else this.tail = combined;
  }
  toBuffer(): Buffer {
    const parts = [...this.head];
    if (this.dropped > 0) parts.push(Buffer.from(`\n...[${this.dropped} bytes omitted by sandbox]...\n`));
    parts.push(this.tail);
    return Buffer.concat(parts);
  }
}

export interface DockerResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  killed: boolean;
}

/** Run `docker <args>`. Never rejects for non-zero exit codes; rejects only if docker can't spawn. */
export function docker(args: string[], opts: { input?: Buffer | string; timeoutMs?: number; uncapped?: boolean } = {}): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = new CappedBuffer(opts.uncapped ? Number.MAX_SAFE_INTEGER : MAX_STREAM_BYTES);
    const err = new CappedBuffer(64 * 1024);
    let killed = false;
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs);
    }
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`failed to run docker: ${e.message}`));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? (killed ? 137 : 1), stdout: out.toBuffer(), stderr: err.toBuffer().toString('utf8'), killed });
    });
    child.stdin.on('error', () => {
      /* EPIPE when the process exits early */
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export async function isDockerAvailable(): Promise<boolean> {
  try {
    const r = await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Minimal ustar writer (deterministic; avoids host-tar quirks such as macOS xattrs)
// ---------------------------------------------------------------------------

function tarHeader(name: string, size: number, mode: number, type: '0' | '5'): Buffer {
  const h = Buffer.alloc(512);
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 154);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`path too long for tar: ${name}`);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  const put = (s: string, off: number, len: number) => h.write(s, off, len, 'utf8');
  const oct = (n: number, off: number, len: number) => put(n.toString(8).padStart(len - 1, '0') + '\0', off, len);
  put(name, 0, 100);
  oct(mode, 100, 8);
  oct(0, 108, 8);
  oct(0, 116, 8);
  oct(size, 124, 12);
  oct(0, 136, 12); // fixed mtime → deterministic
  h.fill(' ', 148, 156);
  put(type, 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

/** Build a tar archive of `entries` (posix relative paths). Directories end with '/'. */
export function buildTar(entries: { path: string; data?: Buffer; mode?: number }[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    if (e.path.endsWith('/')) {
      parts.push(tarHeader(e.path, 0, e.mode ?? 0o755, '5'));
    } else {
      const data = e.data ?? Buffer.alloc(0);
      parts.push(tarHeader(e.path, data.length, e.mode ?? 0o644, '0'));
      parts.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** Tar a host directory (excluding names in `exclude`). */
export function tarDirectory(dir: string, exclude: string[] = ['node_modules', '.DS_Store']): Buffer {
  const entries: { path: string; data?: Buffer; mode?: number }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (exclude.includes(name)) continue;
      const full = join(d, name);
      const rel = relative(dir, full).split('\\').join('/');
      const st = statSync(full);
      if (st.isDirectory()) {
        entries.push({ path: rel + '/' });
        walk(full);
      } else if (st.isFile()) {
        entries.push({ path: rel, data: readFileSync(full), mode: st.mode & 0o111 ? 0o755 : 0o644 });
      }
    }
  };
  walk(dir);
  return buildTar(entries);
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export interface CreateSandboxOptions {
  image: string;
  imageId?: string;
  runId: string;
  role: 'coding' | 'eval';
  /** Docker network. Default 'none'. The eval role may pass e.g. 'bridge' together with `publish`. */
  network?: string;
  /** Ports to publish on 127.0.0.1 only. hostPort omitted/0 = random. */
  publish?: { containerPort: number; hostPort?: number }[];
  cpus?: number;
  memory?: string;
  pidsLimit?: number;
  tmpSizeMb?: number;
  /** Host directory copied to /spec (root-owned, read-only for the agent). */
  specDir?: string;
  env?: Record<string, string>;
  /** Default exec user (default 'node'). */
  user?: string;
  /** Try `--storage-opt size=<n>G` (unsupported on Docker Desktop overlayfs; falls back). */
  storageLimitGb?: number;
  labels?: Record<string, string>;
  /** Container command (default: sleep infinity). */
  command?: string[];
  /** Extra tmpfs mounts, e.g. '/home/node:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0755'. */
  extraTmpfs?: string[];
  /** HOME inside the container (default /tmp). */
  home?: string;
}

let storageOptSupported: boolean | undefined;

export class DockerSandbox implements Sandbox {
  private destroyed = false;
  constructor(
    readonly containerId: string,
    readonly imageId: string,
    readonly name: string,
    private readonly defaultUser: string,
  ) {}

  async exec(command: string, opts: { timeoutSec?: number; cwd?: string; user?: string; env?: Record<string, string> } = {}): Promise<ExecResult> {
    const t = Math.max(1, Math.round(opts.timeoutSec ?? 120));
    const args = ['exec', '-u', opts.user ?? this.defaultUser, '-w', opts.cwd ?? '/workspace'];
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push('-e', `${k}=${v}`);
    // `timeout` runs the command in its own process group and signals the whole group, so
    // children of the shell die too. -k escalates to SIGKILL after 5 s.
    args.push(this.containerId, 'timeout', '-k', '5', `${t}s`, 'bash', '-c', command);
    const start = Date.now();
    // Host-side backstop in case the in-container timeout itself hangs.
    const r = await docker(args, { timeoutMs: (t + 20) * 1000 });
    const durationMs = Date.now() - start;
    const timedOut = r.killed || ((r.code === 124 || r.code === 137) && durationMs >= t * 1000 - 250);
    return { exitCode: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr, timedOut, durationMs };
  }

  async readFileBuffer(path: string): Promise<Buffer> {
    const r = await docker(['exec', '-u', this.defaultUser, this.containerId, 'cat', '--', path], { timeoutMs: 60_000, uncapped: true });
    if (r.code !== 0) throw new Error(r.stderr.trim() || `cannot read ${path}`);
    return r.stdout;
  }

  async readFile(path: string): Promise<string> {
    return (await this.readFileBuffer(path)).toString('utf8');
  }

  async writeFileBuffer(path: string, content: Buffer, opts: { user?: string } = {}): Promise<void> {
    const r = await docker(
      ['exec', '-i', '-u', opts.user ?? this.defaultUser, this.containerId, 'sh', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'sh', path],
      { input: content, timeoutMs: 60_000 },
    );
    if (r.code !== 0) throw new Error(r.stderr.trim() || `cannot write ${path}`);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.writeFileBuffer(path, Buffer.from(content, 'utf8'));
  }

  /** Entries of a directory; directories get a trailing '/'. Sorted. */
  async listDir(path: string): Promise<string[]> {
    const r = await docker(['exec', '-u', this.defaultUser, this.containerId, 'find', path, '-mindepth', '1', '-maxdepth', '1', '-printf', '%f\t%y\n'], {
      timeoutMs: 60_000,
    });
    if (r.code !== 0) throw new Error(r.stderr.trim() || `cannot list ${path}`);
    return r.stdout
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, type] = l.split('\t');
        return type === 'd' ? `${name}/` : name;
      })
      .sort();
  }

  /** Copy a host directory into the container (tar over docker exec stdin). */
  async copyIn(hostDir: string, containerDir: string, opts: { user?: string; exclude?: string[] } = {}): Promise<void> {
    const tar = tarDirectory(hostDir, opts.exclude);
    const r = await docker(
      ['exec', '-i', '-u', opts.user ?? this.defaultUser, this.containerId, 'sh', '-c', 'mkdir -p -- "$1" && tar -x --no-same-owner -C "$1" -f -', 'sh', containerDir],
      { input: tar, timeoutMs: 300_000 },
    );
    if (r.code !== 0) throw new Error(`copyIn ${hostDir} -> ${containerDir} failed: ${r.stderr.trim()}`);
  }

  /** Copy a container directory to the host, excluding node_modules. hostPath is created. */
  async copyOut(containerPath: string, hostPath: string, opts: { exclude?: string[] } = {}): Promise<void> {
    mkdirSync(hostPath, { recursive: true });
    const exclude = opts.exclude ?? ['node_modules'];
    const tarArgs = ['tar', '-c', '-C', containerPath, ...exclude.map((e) => `--exclude=${e}`), '-f', '-', '.'];
    await new Promise<void>((resolve, reject) => {
      const src = spawn('docker', ['exec', '-u', this.defaultUser, this.containerId, ...tarArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
      // bsdtar/GNU tar on the host refuse absolute paths and '..' by default.
      const dst = spawn('tar', ['-x', '-f', '-', '-C', hostPath], { stdio: ['pipe', 'ignore', 'pipe'] });
      let srcErr = '';
      let dstErr = '';
      src.stderr.on('data', (c) => (srcErr += c));
      dst.stderr.on('data', (c) => (dstErr += c));
      src.stdout.pipe(dst.stdin);
      dst.stdin.on('error', () => {});
      const timer = setTimeout(() => {
        src.kill('SIGKILL');
        dst.kill('SIGKILL');
      }, 600_000);
      let srcCode: number | null = null;
      src.on('error', (e) => reject(e));
      dst.on('error', (e) => reject(e));
      src.on('close', (c) => (srcCode = c));
      dst.on('close', (c) => {
        clearTimeout(timer);
        // GNU tar exits 1 if files changed while reading; the archive is still usable.
        if (c !== 0 || (srcCode !== 0 && srcCode !== 1 && srcCode !== null)) {
          reject(new Error(`copyOut ${containerPath} failed (src ${srcCode}, dst ${c}): ${srcErr.slice(-500)} ${dstErr.slice(-500)}`));
        } else resolve();
      });
    });
  }

  /** Disk usage of a path in MiB (du -sk). Returns NaN on failure. */
  async diskUsageMB(path = '/workspace'): Promise<number> {
    const r = await docker(['exec', '-u', this.defaultUser, this.containerId, 'du', '-sk', path], { timeoutMs: 60_000 });
    const kb = parseInt(r.stdout.toString('utf8'), 10);
    return Number.isFinite(kb) ? kb / 1024 : NaN;
  }

  /** Host port bound for a published container port, e.g. for the evaluator. */
  async hostPort(containerPort: number): Promise<number | undefined> {
    const r = await docker(['port', this.containerId, `${containerPort}/tcp`], { timeoutMs: 15_000 });
    const m = /:(\d+)\s*$/m.exec(r.stdout.toString('utf8'));
    return m ? Number(m[1]) : undefined;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    const r = await docker(['rm', '-f', '-v', this.containerId], { timeoutMs: 60_000 }).catch((e) => ({ code: 1, stderr: String(e) }));
    if (r.code !== 0 && !/No such container/i.test(r.stderr)) log.warn('failed to remove container', { id: this.containerId, error: r.stderr });
  }
}

export async function createSandbox(opts: CreateSandboxOptions): Promise<DockerSandbox> {
  const user = opts.user ?? 'node';
  const name = `frugal-${opts.role}-${opts.runId.replace(/[^a-zA-Z0-9_.-]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const labels: Record<string, string> = {
    'frugal.role': opts.role,
    'frugal.runId': opts.runId,
    'frugal.createdAt': new Date().toISOString(),
    ...(opts.labels ?? {}),
  };
  const base = [
    'run', '-d',
    '--name', name,
    '--network', opts.network ?? 'none',
    '--user', user,
    '--cpus', String(opts.cpus ?? 2),
    '--memory', opts.memory ?? '2g',
    '--memory-swap', opts.memory ?? '2g',
    '--pids-limit', String(opts.pidsLimit ?? 512),
    '--read-only',
    '--tmpfs', `/tmp:rw,nosuid,nodev,size=${opts.tmpSizeMb ?? 512}m`,
    '--tmpfs', '/spec:rw,nosuid,nodev,noexec,size=64m,mode=0755',
    '-v', '/workspace',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--init',
    '-e', `HOME=${opts.home ?? '/tmp'}`,
    '-e', 'CI=1',
  ];
  for (const t of opts.extraTmpfs ?? []) base.push('--tmpfs', t);
  for (const [k, v] of Object.entries(labels)) base.push('--label', `${k}=${v}`);
  for (const [k, v] of Object.entries(opts.env ?? {})) base.push('-e', `${k}=${v}`);
  for (const p of opts.publish ?? []) base.push('-p', `127.0.0.1:${p.hostPort ?? 0}:${p.containerPort}`);
  const tail = [opts.image, ...(opts.command ?? ['sleep', 'infinity'])];

  let r: DockerResult;
  const wantStorage = opts.storageLimitGb && storageOptSupported !== false;
  if (wantStorage) {
    r = await docker([...base, '--storage-opt', `size=${opts.storageLimitGb}G`, ...tail], { timeoutMs: 120_000 });
    if (r.code !== 0 && /storage-opt|quota|xfs|not supported/i.test(r.stderr)) {
      storageOptSupported = false;
      log.warn('docker --storage-opt size is not supported here; relying on du-based workspace limit', { error: r.stderr.trim() });
      await docker(['rm', '-f', '-v', name], { timeoutMs: 30_000 }).catch(() => undefined);
      r = await docker([...base, ...tail], { timeoutMs: 120_000 });
    } else if (r.code === 0) storageOptSupported = true;
  } else {
    r = await docker([...base, ...tail], { timeoutMs: 120_000 });
  }
  if (r.code !== 0) {
    await docker(['rm', '-f', '-v', name], { timeoutMs: 30_000 }).catch(() => undefined);
    throw new Error(`docker run failed (exit ${r.code}): ${r.stderr.trim()}`);
  }
  const containerId = r.stdout.toString('utf8').trim();
  const sb = new DockerSandbox(containerId, opts.imageId ?? '', name, user);
  try {
    if (opts.specDir) await sb.copyIn(opts.specDir, '/spec', { user: 'root' });
  } catch (e) {
    await sb.destroy();
    throw e;
  }
  log.debug('sandbox created', { name, role: opts.role, runId: opts.runId });
  return sb;
}

/**
 * Remove containers labelled frugal.role that are older than `olderThanMinutes` (default 180),
 * or all of them with `all: true`. Returns the number removed.
 */
export async function cleanupAbandonedContainers(opts: { olderThanMinutes?: number; all?: boolean; /** extra label filter, e.g. 'frugal.runId=x' */ label?: string } = {}): Promise<number> {
  const extra = opts.label ? ['--filter', `label=${opts.label}`] : [];
  const ls = await docker(['ps', '-a', '--filter', 'label=frugal.role', ...extra, '--format', '{{.ID}}\t{{.Label "frugal.createdAt"}}\t{{.Label "frugal.role"}}'], {
    timeoutMs: 30_000,
  });
  if (ls.code !== 0) throw new Error(`docker ps failed: ${ls.stderr.trim()}`);
  const cutoff = Date.now() - (opts.olderThanMinutes ?? 180) * 60_000;
  let removed = 0;
  for (const line of ls.stdout.toString('utf8').split('\n').filter(Boolean)) {
    const [id, createdAt, role] = line.split('\t');
    if (role === 'benchmark-image') continue;
    const ts = Date.parse(createdAt);
    if (!opts.all && Number.isFinite(ts) && ts > cutoff) continue;
    if (!opts.all && !Number.isFinite(ts)) {
      // Fall back to docker's own creation time.
      const ins = await docker(['inspect', '--format', '{{.Created}}', id], { timeoutMs: 15_000 });
      const created = Date.parse(ins.stdout.toString('utf8').trim());
      if (Number.isFinite(created) && created > cutoff) continue;
    }
    const rm = await docker(['rm', '-f', '-v', id], { timeoutMs: 60_000 });
    if (rm.code === 0) removed++;
  }
  if (removed) log.info('removed abandoned containers', { removed });
  await cleanupCodingNetworks({ ...opts, cutoff }).catch((e) => log.warn('coding network cleanup failed', { error: String(e) }));
  return removed;
}

/**
 * Remove per-run coding networks (label frugal.role=coding, used by the claude-code backend's
 * gateway forwarder) matching the same filters. Networks still in use are left alone by docker.
 */
async function cleanupCodingNetworks(opts: { all?: boolean; label?: string; cutoff: number }): Promise<void> {
  const extra = opts.label ? ['--filter', `label=${opts.label}`] : [];
  const ls = await docker(['network', 'ls', '--filter', 'label=frugal.role=coding', ...extra, '--format', '{{.ID}}\t{{.Label "frugal.createdAt"}}'], { timeoutMs: 30_000 });
  if (ls.code !== 0) return;
  for (const line of ls.stdout.toString('utf8').split('\n').filter(Boolean)) {
    const [id, createdAt] = line.split('\t');
    const ts = Date.parse(createdAt);
    if (!opts.all && (!Number.isFinite(ts) || ts > opts.cutoff)) continue;
    await docker(['network', 'rm', id], { timeoutMs: 30_000 });
  }
}

