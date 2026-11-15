/**
 * Launches a generated app snapshot in a FRESH, isolated eval container.
 *
 * Topology (no iptables needed, works on Docker Desktop):
 *
 *   host 127.0.0.1:<port>       ──► proxy :8080 (clean)     ┐ proxy container (default bridge +
 *   host 127.0.0.1:<agentPort>  ──► proxy :8081 (faultable) ┘ per-run internal net)
 *                                         │  HTTP reverse proxy (evaluator/fault-proxy.ts)
 *                                         ▼
 *                          app container (per-run `--internal` network only → NO egress)
 *
 * The app container is attached only to a per-run `--internal` network, so it can't reach the
 * internet or the host. An `--internal` network can't publish ports, so a small trusted HTTP
 * forwarder (evaluator-owned script run with node from the same benchmark image, not app code) is
 * attached to both that network and the default bridge, and publishes 127.0.0.1 ports only.
 * `url` is never faulted; `agentUrl` (the LLM browser agent's page) can be switched into fault
 * modes by the host only (`setFaultMode`, a `docker exec` writing the proxy's mode file).
 *
 * Failure classes:
 *   AppStartupError     – the app's fault (build failed, process exited, never became ready)
 *   EvaluatorInfraError – docker / evaluator problems (not the app's fault; retried by evaluateRun)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../runner/logger.js';
import { containerState, docker, runCmd } from './docker.js';
import { FAULT_MODES, FAULT_PROXY_SCRIPT, PROXY_AGENT_PORT, PROXY_CLEAN_PORT, PROXY_FAULT_FILE, type FaultMode } from './fault-proxy.js';

const log = logger('evaluator.launcher');

export const APP_PORT_IN_CONTAINER = 3000;
export const DB_DIR_IN_CONTAINER = '/workspace/.evaldata';
export const DB_PATH_IN_CONTAINER = `${DB_DIR_IN_CONTAINER}/todos.db`;

export class AppStartupError extends Error {
  readonly kind = 'startup' as const;
  constructor(
    message: string,
    readonly phase: 'copy' | 'build' | 'start' | 'ready',
    readonly logs: string,
  ) {
    super(message);
    this.name = 'AppStartupError';
  }
}

export class EvaluatorInfraError extends Error {
  readonly kind = 'infra' as const;
  constructor(message: string) {
    super(message);
    this.name = 'EvaluatorInfraError';
  }
}

/** The app's DB is missing/unreadable/has no todos table: the app's fault. */
export class AppDbError extends Error {
  readonly kind = 'app-db' as const;
  constructor(message: string) {
    super(message);
    this.name = 'AppDbError';
  }
}

export interface TodoRow {
  id: number;
  title: string;
  completed: number;
  created_at: string;
}

export interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export interface LaunchedApp {
  /** e.g. http://127.0.0.1:41234 (no trailing slash). Never fault-injected. */
  readonly url: string;
  /** Same app through the faultable proxy listener (used only by the LLM browser agent's page). */
  readonly agentUrl: string;
  /** Switch the fault mode of `agentUrl` (host-only control; resets to 'off' on every launch). */
  setFaultMode(mode: FaultMode): Promise<void>;
  readonly containerId: string;
  readonly containerName: string;
  /** Rows of the `todos` table ordered by id. Throws AppDbError if DB/table missing. */
  readDb(): Promise<TodoRow[]>;
  /** Run an arbitrary read-only query against the app DB. */
  queryDb<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  /** Execute a writing statement directly against the app DB (used to set up ordering edge cases). */
  writeDb(sql: string): Promise<void>;
  /** PRAGMA table_info(todos) plus the CREATE statement. */
  dbSchema(): Promise<{ columns: ColumnInfo[]; sql: string }>;
  /** Stop and start the app process in the SAME container (DB kept). */
  restart(): Promise<void>;
  /** Restart the app with a fresh (deleted) database. */
  resetDb(): Promise<void>;
  /** Destroy containers + network. Idempotent, never throws. */
  stop(): Promise<void>;
  /** Build + app logs collected so far. */
  logs(): string;
}

export interface LaunchOptions {
  appDir: string;
  runId: string;
  image: string;
  buildTimeoutMs?: number;
  readyTimeoutMs?: number;
  /** Readiness URL path (default /api/todos per the app contract; '/' only for calibration tooling). */
  readyPath?: string;
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

let tarFlavor: 'bsd' | 'gnu' | null = null;
async function tarOwnerArgs(): Promise<string[]> {
  if (!tarFlavor) {
    const r = await runCmd('tar', ['--version']);
    tarFlavor = /bsdtar/i.test(r.stdout) ? 'bsd' : 'gnu';
  }
  return tarFlavor === 'bsd'
    ? ['--uid', '1000', '--gid', '1000', '--no-xattrs', '--no-mac-metadata', '--no-acls', '--no-fflags']
    : ['--owner=1000', '--group=1000', '--numeric-owner'];
}

/** Files never copied from a snapshot into the eval container. */
const TAR_EXCLUDES = [
  'node_modules',
  '.git',
  '*.db',
  '*.db-wal',
  '*.db-shm',
  '*.sqlite',
  '*.sqlite3',
  '.evaldata',
];

// The proxy is evaluator-owned code, never app code (see fault-proxy.ts).

const HARDENING = [
  '--read-only',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--user',
  'node',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function launchApp(opts: LaunchOptions): Promise<LaunchedApp> {
  const buildTimeoutMs = opts.buildTimeoutMs ?? 5 * 60_000;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
  if (!fs.existsSync(opts.appDir) || !fs.statSync(opts.appDir).isDirectory()) {
    // A missing snapshot means the coding run produced nothing usable: that's the app's fault.
    throw new AppStartupError(`app snapshot directory not found: ${opts.appDir}`, 'copy', '');
  }
  const suffix = randomBytes(3).toString('hex');
  const base = `frugal-eval-${sanitize(opts.runId)}-${suffix}`;
  const netName = `${base}-net`;
  const appName = `${base}-app`;
  const proxyName = `${base}-proxy`;
  const labels = ['--label', 'frugal.role=eval', '--label', `frugal.runId=${opts.runId}`];

  let logBuf = '';
  const appendLog = (s: string) => {
    logBuf += s;
    if (logBuf.length > 400_000) logBuf = logBuf.slice(-200_000);
  };
  let appProc: ChildProcess | null = null;
  let stopped = false;
  let port = 0;
  let agentPort = 0;

  const infra = async (what: string, r: { code: number; stderr: string; stdout: string }) => {
    throw new EvaluatorInfraError(`${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 2000)}`);
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      appProc?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    await docker(['rm', '-f', '-v', appName, proxyName], { timeoutMs: 60_000 });
    await docker(['network', 'rm', netName], { timeoutMs: 30_000 });
  };

  try {
    // 1. Per-run internal network (no egress).
    let r = await docker(['network', 'create', '--internal', ...labels, netName], { timeoutMs: 30_000 });
    if (r.code !== 0) await infra('docker network create', r);

    // 2. App container: same limits as the coding container, anonymous volume for /workspace so the
    //    image's node_modules are kept and the root fs stays read-only.
    r = await docker(
      [
        'create',
        '--name', appName,
        ...labels,
        '--label', 'frugal.component=app',
        '--init',
        '--cpus', '2',
        '--memory', '2g',
        '--pids-limit', '512',
        ...HARDENING,
        '--tmpfs', '/tmp:rw,exec,size=512m',
        '--mount', 'type=volume,dst=/workspace',
        '--network', netName,
        '--network-alias', 'app',
        '-e', `PORT=${APP_PORT_IN_CONTAINER}`,
        '-e', `DATABASE_PATH=${DB_PATH_IN_CONTAINER}`,
        '-e', 'NODE_ENV=production',
        '-w', '/workspace',
        opts.image,
        'sleep', 'infinity',
      ],
      { timeoutMs: 60_000 },
    );
    if (r.code !== 0) await infra('docker create (app)', r);
    const containerId = r.stdout.trim();
    r = await docker(['start', appName], { timeoutMs: 60_000 });
    if (r.code !== 0) await infra('docker start (app)', r);

    // 3. Replace the workspace contents (keep node_modules) with the snapshot.
    r = await docker(
      ['exec', appName, 'sh', '-c', 'find /workspace -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +'],
      { timeoutMs: 60_000 },
    );
    if (r.code !== 0) await infra('clearing /workspace', r);
    const tarArgs = ['-c', ...(await tarOwnerArgs()), ...TAR_EXCLUDES.flatMap((e) => ['--exclude', e]), '-C', opts.appDir, '.'];
    const tar = spawn('tar', tarArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
    let tarErr = '';
    tar.stderr.on('data', (d) => (tarErr += d.toString()));
    r = await docker(['cp', '-a', '-', `${appName}:/workspace`], { input: tar.stdout, timeoutMs: 120_000 });
    if (r.code !== 0) await infra(`docker cp snapshot (${tarErr.trim()})`, r);
    r = await docker(['exec', appName, 'mkdir', '-p', DB_DIR_IN_CONTAINER], { timeoutMs: 30_000 });
    if (r.code !== 0) await infra('mkdir db dir', r);

    // 4. Proxy publishing 127.0.0.1 only.
    let proxyOk = false;
    for (let attempt = 0; attempt < 3 && !proxyOk; attempt++) {
      port = await freePort();
      do agentPort = await freePort();
      while (agentPort === port);
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
          '-e', `CLEAN_PORT=${PROXY_CLEAN_PORT}`,
          '-e', `AGENT_PORT=${PROXY_AGENT_PORT}`,
          '-e', `FAULT_FILE=${PROXY_FAULT_FILE}`,
          '-e', `UPSTREAM_PORT=${APP_PORT_IN_CONTAINER}`,
          '-p', `127.0.0.1:${port}:${PROXY_CLEAN_PORT}`,
          '-p', `127.0.0.1:${agentPort}:${PROXY_AGENT_PORT}`,
          opts.image,
          'node', '-e', FAULT_PROXY_SCRIPT,
        ],
        { timeoutMs: 60_000 },
      );
      if (r.code !== 0) await infra('docker create (proxy)', r);
      r = await docker(['network', 'connect', netName, proxyName], { timeoutMs: 30_000 });
      if (r.code !== 0) await infra('docker network connect (proxy)', r);
      r = await docker(['start', proxyName], { timeoutMs: 60_000 });
      if (r.code === 0) proxyOk = true;
      else if (!/already allocated|address already in use/i.test(r.stderr)) await infra('docker start (proxy)', r);
    }
    if (!proxyOk) throw new EvaluatorInfraError('could not publish a free port for the proxy');
    const url = `http://127.0.0.1:${port}`;
    const agentUrl = `http://127.0.0.1:${agentPort}`;

    // 5. Build.
    appendLog(`$ npm run build\n`);
    r = await docker(['exec', appName, 'npm', 'run', 'build'], { timeoutMs: buildTimeoutMs });
    appendLog(r.stdout + r.stderr);
    if (r.code !== 0) {
      const st = await containerState(appName);
      if (!st || (!st.running && !st.oomKilled)) await infra('docker exec npm run build (container gone)', r);
      throw new AppStartupError(
        r.timedOut
          ? `npm run build timed out after ${Math.round(buildTimeoutMs / 1000)}s`
          : `npm run build failed (exit ${r.code})${st?.oomKilled ? ' (OOM killed)' : ''}`,
        'build',
        logBuf,
      );
    }

    const startApp = async () => {
      appendLog(`\n$ npm start\n`);
      const child = spawn('docker', ['exec', appName, 'npm', 'start'], { stdio: ['ignore', 'pipe', 'pipe'] });
      appProc = child;
      let exited: number | null = null;
      child.stdout?.on('data', (d: Buffer) => appendLog(d.toString()));
      child.stderr?.on('data', (d: Buffer) => appendLog(d.toString()));
      child.on('close', (code) => {
        exited = code ?? 1;
      });
      const deadline = Date.now() + readyTimeoutMs;
      let lastErr = '';
      // The server answers but never with 200 (e.g. the starter's 501 placeholder): give up early.
      let badStatusSince: number | null = null;
      const BAD_STATUS_GRACE_MS = 15_000;
      while (Date.now() < deadline) {
        if (exited !== null) {
          const st = await containerState(appName);
          if (!st || !st.running) {
            if (st?.oomKilled) throw new AppStartupError('app container was OOM killed during startup', 'start', logBuf);
            throw new EvaluatorInfraError(`app container stopped unexpectedly (${st?.status ?? 'missing'})`);
          }
          throw new AppStartupError(`npm start exited with code ${exited} before becoming ready`, 'start', logBuf);
        }
        try {
          const res = await fetch(`${url}${opts.readyPath ?? '/api/todos'}`, { signal: AbortSignal.timeout(3000) });
          await res.arrayBuffer().catch(() => undefined);
          if (res.status === 200) return;
          lastErr = `GET ${opts.readyPath ?? '/api/todos'} returned ${res.status}`;
          badStatusSince ??= Date.now();
          if (Date.now() - badStatusSince > BAD_STATUS_GRACE_MS) {
            throw new AppStartupError(`app is up but ${lastErr} for ${BAD_STATUS_GRACE_MS / 1000}s`, 'ready', logBuf);
          }
        } catch (e) {
          if (e instanceof AppStartupError) throw e;
          lastErr = String((e as Error).message);
          badStatusSince = null;
        }
        await sleep(300);
      }
      const proxySt = await containerState(proxyName);
      if (!proxySt?.running) throw new EvaluatorInfraError('evaluator proxy container is not running');
      throw new AppStartupError(
        `app not ready within ${Math.round(readyTimeoutMs / 1000)}s (${lastErr || 'no response'})`,
        'ready',
        logBuf,
      );
    };

    const restartContainer = async () => {
      const rr = await docker(['restart', '-t', '2', appName], { timeoutMs: 60_000 });
      if (rr.code !== 0) await infra('docker restart (app)', rr);
    };

    await startApp();
    log.info('app ready', { runId: opts.runId, url, container: appName });

    let sqliteCli: boolean | null = null;
    const queryDb = async <T,>(sql: string, write = false): Promise<T[]> => {
      const exists = await docker(['exec', appName, 'test', '-f', DB_PATH_IN_CONTAINER], { timeoutMs: 30_000 });
      if (exists.code === 1) throw new AppDbError(`database file ${DB_PATH_IN_CONTAINER} (DATABASE_PATH) does not exist`);
      if (exists.code !== 0) await infra('docker exec test -f', exists);
      if (sqliteCli === null) {
        const c = await docker(['exec', appName, 'sh', '-c', 'command -v sqlite3'], { timeoutMs: 30_000 });
        sqliteCli = c.code === 0;
      }
      if (sqliteCli) {
        const q = await docker(
          ['exec', appName, 'sqlite3', '-json', '-cmd', '.timeout 5000', ...(write ? [] : ['-readonly']), DB_PATH_IN_CONTAINER, sql],
          { timeoutMs: 30_000 },
        );
        if (q.code !== 0) {
          if (/no such table|no such column|file is not a database|malformed/i.test(q.stderr)) {
            throw new AppDbError(q.stderr.trim().slice(0, 500));
          }
          await infra('sqlite3 query', q);
        }
        const out = q.stdout.trim();
        return out ? (JSON.parse(out) as T[]) : [];
      }
      if (write) throw new EvaluatorInfraError('writeDb requires the sqlite3 CLI in the benchmark image');
      return hostQuery<T>(appName, sql);
    };

    const setFaultMode = async (mode: FaultMode) => {
      if (!(FAULT_MODES as readonly string[]).includes(mode)) throw new EvaluatorInfraError(`unknown fault mode ${mode}`);
      const rr = await docker(['exec', proxyName, 'sh', '-c', `printf '%s' "$1" > ${PROXY_FAULT_FILE}`, 'sh', mode], { timeoutMs: 30_000 });
      if (rr.code !== 0) await infra(`setting proxy fault mode ${mode}`, rr);
    };

    const app: LaunchedApp = {
      url,
      agentUrl,
      setFaultMode,
      containerId,
      containerName: appName,
      readDb: () =>
        queryDb<TodoRow>('SELECT id, title, completed, created_at FROM todos ORDER BY id'),
      queryDb: <T,>(sql: string) => queryDb<T>(sql),
      async writeDb(sql) {
        await queryDb(sql, true);
      },
      async dbSchema() {
        const columns = await queryDb<ColumnInfo>("SELECT * FROM pragma_table_info('todos')");
        const sqlRows = await queryDb<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='todos'");
        if (!sqlRows.length) throw new AppDbError('table `todos` does not exist');
        return { columns, sql: sqlRows[0].sql };
      },
      async restart() {
        await restartContainer();
        await startApp();
      },
      async resetDb() {
        await restartContainer();
        const rr = await docker(
          ['exec', appName, 'sh', '-c', `rm -rf ${DB_DIR_IN_CONTAINER} && mkdir -p ${DB_DIR_IN_CONTAINER}`],
          { timeoutMs: 30_000 },
        );
        if (rr.code !== 0) await infra('reset db', rr);
        await startApp();
      },
      stop,
      logs: () => logBuf,
    };
    return app;
  } catch (err) {
    await stop();
    if (err instanceof AppStartupError || err instanceof EvaluatorInfraError) throw err;
    throw new EvaluatorInfraError(`launchApp: ${(err as Error).message}`);
  }
}

/** Fallback when the image has no sqlite3 CLI: docker cp the DB (+WAL) and read with host better-sqlite3. */
async function hostQuery<T>(container: string, sql: string): Promise<T[]> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-evaldb-'));
  try {
    for (const ext of ['', '-wal', '-shm']) {
      const r = await docker(['cp', `${container}:${DB_PATH_IN_CONTAINER}${ext}`, path.join(tmp, `todos.db${ext}`)], {
        timeoutMs: 30_000,
      });
      if (r.code !== 0 && ext === '') throw new AppDbError('database file could not be copied out');
    }
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path.join(tmp, 'todos.db'));
    try {
      return db.prepare(sql).all() as T[];
    } catch (e) {
      throw new AppDbError((e as Error).message);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Remove leftover eval containers and networks (label frugal.role=eval).
 * With `runIds`, only resources of those runs are touched (safe while another process evaluates).
 * Without it, ALL eval resources are removed: call that only at startup of a single-writer process.
 * Returns the number of containers removed.
 */
export async function cleanupEvalResources(opts: { runIds?: string[] } = {}): Promise<number> {
  const filters: string[][] = opts.runIds
    ? opts.runIds.map((id) => ['--filter', 'label=frugal.role=eval', '--filter', `label=frugal.runId=${id}`])
    : [['--filter', 'label=frugal.role=eval']];
  let removed = 0;
  for (const f of filters) {
    const ps = await docker(['ps', '-aq', ...f], { timeoutMs: 30_000 });
    const ids = ps.stdout.split(/\s+/).filter(Boolean);
    if (ids.length) {
      const rm = await docker(['rm', '-f', '-v', ...ids], { timeoutMs: 120_000 });
      if (rm.code === 0) removed += ids.length;
    }
    const nets = await docker(['network', 'ls', '-q', ...f], { timeoutMs: 30_000 });
    for (const n of nets.stdout.split(/\s+/).filter(Boolean)) await docker(['network', 'rm', n], { timeoutMs: 30_000 });
  }
  return removed;
}
