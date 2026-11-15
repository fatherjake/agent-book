/**
 * Minimal helper to run an app directory (starter layout, no node_modules) inside the benchmark
 * image and publish it on 127.0.0.1. Used by scripts/generate-design.ts and benchmark tests.
 * The evaluator has its own hardened sandbox; this mirrors its container model.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

export interface AppContainer {
  name: string;
  baseUrl: string;
  port: number;
  logs(): Promise<string>;
  stop(): Promise<void>;
}

function docker(
  args: string[],
  opts: { stdinFrom?: { cmd: string; args: string[] } } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: [opts.stdinFrom ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts.stdinFrom) {
      // COPYFILE_DISABLE stops macOS tar from adding AppleDouble (._*) files.
      const src = spawn(opts.stdinFrom.cmd, opts.stdinFrom.args, {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      });
      src.on('error', reject);
      src.stdout.pipe(child.stdin!);
    }
  });
}

async function mustDocker(args: string[], opts?: Parameters<typeof docker>[1]): Promise<string> {
  const r = await docker(args, opts);
  if (r.code !== 0) throw new Error(`docker ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/**
 * Start `appDir` in a fresh container from `image`: copy it over /workspace (keeping the image's
 * node_modules), run `npm run build && npm start`, and wait until GET /api/todos returns 200.
 */
export async function startAppContainer(opts: {
  image: string;
  appDir: string;
  name?: string;
  readyTimeoutMs?: number;
  env?: Record<string, string>;
}): Promise<AppContainer> {
  const name = opts.name ?? `frugal-app-${process.pid}-${Date.now()}`;
  const envArgs = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  await mustDocker([
    'run', '-d', '--name', name,
    '--label', 'frugal.role=eval', '--label', `frugal.runId=${name}`,
    '--read-only', '-v', '/workspace', '--tmpfs', '/tmp',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--cpus', '2', '--memory', '2g', '--pids-limit', '512',
    '-p', '127.0.0.1::3000',
    ...envArgs,
    opts.image, 'sleep', 'infinity',
  ]);
  const stop = async () => {
    await docker(['rm', '-f', '-v', name]);
  };
  try {
    // Extract as user node so ownership stays correct (docker cp would create root-owned files).
    await mustDocker(['exec', '-i', '-u', 'node', name, 'tar', '-x', '-C', '/workspace'], {
      stdinFrom: {
        cmd: 'tar',
        args: ['-c', '--exclude', 'node_modules', '--exclude', 'frontend/dist', '--exclude', 'data',
          '-C', path.resolve(opts.appDir), '.'],
      },
    });
    await mustDocker(['exec', '-d', '-u', 'node', name, 'sh', '-c',
      'cd /workspace && npm run build > /tmp/build.log 2>&1 && exec npm start > /tmp/app.log 2>&1']);
    const portLine = await mustDocker(['port', name, '3000/tcp']);
    const port = Number(portLine.split('\n')[0].split(':').pop());
    const baseUrl = `http://127.0.0.1:${port}`;
    const logs = async () =>
      (await docker(['exec', name, 'sh', '-c', 'cat /tmp/build.log /tmp/app.log 2>/dev/null'])).stdout;

    const deadline = Date.now() + (opts.readyTimeoutMs ?? 120_000);
    for (;;) {
      try {
        const res = await fetch(`${baseUrl}/api/todos`);
        if (res.status === 200) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`app not ready after timeout. Logs:\n${await logs()}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    return { name, baseUrl, port, logs, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}
