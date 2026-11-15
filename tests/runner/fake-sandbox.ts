/** In-memory Sandbox for runner tests (no Docker). */
import type { ExecResult, Sandbox } from '../../runner/types.js';

export class FakeSandbox implements Sandbox {
  readonly containerId = 'fake-container';
  readonly imageId = 'sha256:fake';
  files = new Map<string, Buffer>();
  commands: string[] = [];
  destroyed = false;
  copiedOut: { from: string; to: string }[] = [];
  /** Custom exec behaviour; return undefined to fall back to the default (exit 0, echo). */
  onExec?: (cmd: string, opts?: { timeoutSec?: number; cwd?: string }) => Partial<ExecResult> | undefined | Promise<Partial<ExecResult> | undefined>;
  failCopyOut = false;

  async exec(command: string, opts?: { timeoutSec?: number; cwd?: string }): Promise<ExecResult> {
    this.commands.push(command);
    const custom = await this.onExec?.(command, opts);
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1, ...(custom ?? {}) };
  }
  async readFile(path: string): Promise<string> {
    const f = this.files.get(path);
    if (!f) throw new Error(`cat: ${path}: No such file or directory`);
    return f.toString('utf8');
  }
  async readFileBuffer(path: string): Promise<Buffer> {
    const f = this.files.get(path);
    if (!f) throw new Error(`cat: ${path}: No such file or directory`);
    return f;
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, Buffer.from(content, 'utf8'));
  }
  async listDir(path: string): Promise<string[]> {
    const prefix = path.replace(/\/+$/, '') + '/';
    const names = new Set<string>();
    for (const k of this.files.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const i = rest.indexOf('/');
      names.add(i === -1 ? rest : rest.slice(0, i + 1));
    }
    if (names.size === 0 && ![...this.files.keys()].some((k) => k.startsWith(prefix))) throw new Error(`find: '${path}': No such file or directory`);
    return [...names].sort();
  }
  async copyOut(from: string, to: string): Promise<void> {
    if (this.failCopyOut) throw new Error('copyOut failed (fake)');
    this.copiedOut.push({ from, to });
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}
