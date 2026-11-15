/**
 * Minimal docker CLI helpers for the evaluator. All calls go through `docker` on the host.
 * The evaluator never mounts the Docker socket into any container.
 */
import { spawn } from 'node:child_process';

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runCmd(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; input?: Buffer | NodeJS.ReadableStream; cwd?: string } = {},
): Promise<CmdResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs);
    }
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
    if (opts.input) {
      if (Buffer.isBuffer(opts.input)) child.stdin.end(opts.input);
      else (opts.input as NodeJS.ReadableStream).pipe(child.stdin);
    } else {
      child.stdin.end();
    }
  });
}

export const docker = (args: string[], opts?: Parameters<typeof runCmd>[2]) => runCmd('docker', args, opts);

/** Is the docker daemon reachable? */
export async function dockerAvailable(): Promise<boolean> {
  const r = await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15_000 });
  return r.code === 0 && r.stdout.trim().length > 0;
}

/** Container state, or null if it does not exist. */
export async function containerState(
  id: string,
): Promise<{ running: boolean; status: string; exitCode: number; oomKilled: boolean } | null> {
  const r = await docker(['inspect', '--format', '{{json .State}}', id], { timeoutMs: 15_000 });
  if (r.code !== 0) return null;
  try {
    const s = JSON.parse(r.stdout.trim());
    return { running: !!s.Running, status: String(s.Status), exitCode: Number(s.ExitCode), oomKilled: !!s.OOMKilled };
  } catch {
    return null;
  }
}
