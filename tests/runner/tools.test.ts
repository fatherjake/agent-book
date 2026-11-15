import { describe, expect, it } from 'vitest';
import { buildToolSpecs, executeTool, resolvePath, truncateOutput, ALL_TOOLS } from '../../runner/tools.js';
import type { ToolConfig } from '../../runner/types.js';
import { FakeSandbox } from './fake-sandbox.js';

const allOn: ToolConfig[] = ALL_TOOLS.map((name) => ({ name, enabled: true }));

describe('resolvePath', () => {
  it('resolves relative paths under /workspace', () => {
    expect(resolvePath('src/a.ts', 'write')).toBe('/workspace/src/a.ts');
    expect(resolvePath('./x/../y.txt', 'write')).toBe('/workspace/y.txt');
  });
  it('confines writes to /workspace', () => {
    expect(() => resolvePath('/spec/requirements.md', 'write')).toThrow(/only allowed under \/workspace/);
    expect(() => resolvePath('../etc/passwd', 'write')).toThrow();
    expect(() => resolvePath('/workspace/../etc/passwd', 'write')).toThrow();
    expect(() => resolvePath('/workspacefoo/x', 'write')).toThrow();
    expect(() => resolvePath('/workspace', 'write')).toThrow();
  });
  it('allows reads from /workspace and /spec only', () => {
    expect(resolvePath('/spec/design.png', 'read')).toBe('/spec/design.png');
    expect(resolvePath('/spec', 'read')).toBe('/spec');
    expect(() => resolvePath('/etc/passwd', 'read')).toThrow(/reads are only allowed/);
    expect(() => resolvePath('/spec/../evaluator/x', 'read')).toThrow();
  });
  it('rejects bad input', () => {
    expect(() => resolvePath('', 'read')).toThrow();
    expect(() => resolvePath(42, 'read')).toThrow();
    expect(() => resolvePath('a\0b', 'read')).toThrow();
  });
});

describe('truncateOutput', () => {
  it('keeps head and tail', () => {
    const s = 'H'.repeat(1000) + 'M'.repeat(5000) + 'T'.repeat(1000);
    const t = truncateOutput(s, 1000);
    expect(t.length).toBeLessThanOrEqual(1000);
    expect(t.startsWith('HHH')).toBe(true);
    expect(t.endsWith('TTT')).toBe(true);
    expect(t).toMatch(/chars truncated/);
  });
  it('leaves short output alone', () => {
    expect(truncateOutput('abc', 10)).toBe('abc');
  });
});

describe('buildToolSpecs', () => {
  it('only enabled tools, canonical order, description override', () => {
    const specs = buildToolSpecs([
      { name: 'run_command', enabled: true, description: 'custom' },
      { name: 'read_file', enabled: true },
      { name: 'view_image', enabled: false },
    ]);
    expect(specs.map((s) => s.name)).toEqual(['read_file', 'run_command']);
    expect(specs[1].description).toBe('custom');
  });
});

describe('executeTool', () => {
  it('write, read, edit round trip', async () => {
    const sb = new FakeSandbox();
    expect((await executeTool('write_file', { path: 'a.txt', content: 'one two one' }, allOn, { sandbox: sb })).isError).toBe(false);
    expect((await executeTool('read_file', { path: '/workspace/a.txt' }, allOn, { sandbox: sb })).content).toBe('one two one');
    const ambiguous = await executeTool('edit_file', { path: 'a.txt', old_string: 'one', new_string: '1' }, allOn, { sandbox: sb });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content).toMatch(/matches 2 times/);
    expect((await executeTool('edit_file', { path: 'a.txt', old_string: 'two', new_string: '$& 2' }, allOn, { sandbox: sb })).isError).toBe(false);
    expect(await sb.readFile('/workspace/a.txt')).toBe('one $& 2 one');
    expect((await executeTool('edit_file', { path: 'a.txt', old_string: 'one', new_string: '1', replace_all: true }, allOn, { sandbox: sb })).isError).toBe(false);
    expect(await sb.readFile('/workspace/a.txt')).toBe('1 $& 2 1');
    expect((await executeTool('edit_file', { path: 'a.txt', old_string: 'zzz', new_string: 'y' }, allOn, { sandbox: sb })).content).toMatch(/not found/);
  });

  it('read_file with offset/limit', async () => {
    const sb = new FakeSandbox();
    await sb.writeFile('/workspace/f', 'l1\nl2\nl3\nl4');
    const r = await executeTool('read_file', { path: 'f', offset: 2, limit: 2 }, allOn, { sandbox: sb });
    expect(r.content).toBe('[lines 2-3 of 4]\nl2\nl3');
  });

  it('path violations and missing files become isError results, never throws', async () => {
    const sb = new FakeSandbox();
    const r1 = await executeTool('write_file', { path: '/etc/x', content: 'x' }, allOn, { sandbox: sb });
    expect(r1).toMatchObject({ isError: true });
    expect(r1.content).toMatch(/only allowed under/);
    const r2 = await executeTool('read_file', { path: 'missing.txt' }, allOn, { sandbox: sb });
    expect(r2.isError).toBe(true);
    const r3 = await executeTool('write_file', { path: 'x' }, allOn, { sandbox: sb });
    expect(r3.content).toMatch(/'content' must be a string/);
    const r4 = await executeTool('nope', {}, allOn, { sandbox: sb });
    expect(r4.content).toMatch(/Unknown or disabled tool/);
    const r5 = await executeTool('run_command', { command: 'ls' }, [{ name: 'run_command', enabled: false }], { sandbox: sb });
    expect(r5.isError).toBe(true);
    const r6 = await executeTool('read_file', null, allOn, { sandbox: sb });
    expect(r6.isError).toBe(true);
  });

  it('run_command formats output, applies timeout config and truncation', async () => {
    const sb = new FakeSandbox();
    let seenTimeout = 0;
    sb.onExec = (_c, o) => {
      seenTimeout = o?.timeoutSec ?? 0;
      return { exitCode: 2, stdout: 'x'.repeat(5000), stderr: 'bad' };
    };
    const cfg: ToolConfig[] = [{ name: 'run_command', enabled: true, maxOutputChars: 500, timeoutSec: 33 }];
    const r = await executeTool('run_command', { command: 'make' }, cfg, { sandbox: sb });
    expect(seenTimeout).toBe(33);
    expect(r.isError).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(500);
    expect(r.content.startsWith('exit code: 2')).toBe(true);
    expect(r.rawChars).toBeGreaterThan(5000);
    await executeTool('run_command', { command: 'x', timeout_sec: 99999 }, cfg, { sandbox: sb });
    expect(seenTimeout).toBe(900);
  });

  it('reports timeouts', async () => {
    const sb = new FakeSandbox();
    sb.onExec = () => ({ exitCode: 124, timedOut: true });
    const r = await executeTool('run_command', { command: 'sleep 1000', timeout_sec: 5 }, allOn, { sandbox: sb });
    expect(r.content).toMatch(/timed out after 5s/);
    expect(r.isError).toBe(true);
  });

  it('raw mode does not truncate; summarize mode calls the summarizer', async () => {
    const sb = new FakeSandbox();
    sb.onExec = () => ({ stdout: 'y'.repeat(3000) });
    const raw = await executeTool('run_command', { command: 'x' }, [{ name: 'run_command', enabled: true, maxOutputChars: 200, outputMode: 'raw' }], { sandbox: sb });
    expect(raw.content.length).toBeGreaterThan(3000);
    let calls = 0;
    const sum = await executeTool('run_command', { command: 'x' }, [{ name: 'run_command', enabled: true, maxOutputChars: 200, outputMode: 'summarize' }], {
      sandbox: sb,
      summarize: async () => {
        calls++;
        return 'SHORT';
      },
    });
    expect(calls).toBe(1);
    expect(sum.summarized).toBe(true);
    expect(sum.content).toMatch(/SHORT/);
    // summarizer failure falls back to truncation
    const fb = await executeTool('run_command', { command: 'x' }, [{ name: 'run_command', enabled: true, maxOutputChars: 200, outputMode: 'summarize' }], {
      sandbox: sb,
      summarize: async () => {
        throw new Error('no');
      },
    });
    expect(fb.truncated).toBe(true);
  });

  it('view_image returns an image block for PNGs and rejects others', async () => {
    const sb = new FakeSandbox();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
    sb.files.set('/spec/design.png', png);
    sb.files.set('/workspace/x.png', Buffer.from('not an image'));
    const r = await executeTool('view_image', { path: '/spec/design.png' }, allOn, { sandbox: sb });
    expect(r.isError).toBe(false);
    expect(r.images?.[0]).toEqual({ mediaType: 'image/png', dataBase64: png.toString('base64') });
    expect((await executeTool('view_image', { path: 'x.png' }, allOn, { sandbox: sb })).isError).toBe(true);
    expect((await executeTool('read_file', { path: '/spec/design.png' }, allOn, { sandbox: sb })).content).toMatch(/view_image/);
  });

  it('list_dir lists entries', async () => {
    const sb = new FakeSandbox();
    await sb.writeFile('/workspace/a/b.txt', '');
    await sb.writeFile('/workspace/c.txt', '');
    const r = await executeTool('list_dir', {}, allOn, { sandbox: sb });
    expect(r.content).toBe('a/\nc.txt');
  });
});
