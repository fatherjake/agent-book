import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DOCKERFILE_PATH,
  STARTER_DIR,
  computeStarterHash,
  imageTag,
  listStarterFiles,
} from '../../benchmark/docker/image.js';

const tmpDirs: string[] = [];
function copyStarter(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-hash-'));
  tmpDirs.push(dir);
  for (const rel of listStarterFiles()) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(STARTER_DIR, rel), dest);
  }
  return dir;
}
afterAll(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('starter hash', () => {
  it('is a stable sha256 hex digest', () => {
    const a = computeStarterHash();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(computeStarterHash()).toBe(a);
    expect(imageTag(a)).toBe(`frugal-bench:${a}`);
  });

  it('matches a byte-identical copy and ignores node_modules, dist, data and .DS_Store', () => {
    const dir = copyStarter();
    const base = computeStarterHash(dir, DOCKERFILE_PATH);
    expect(base).toBe(computeStarterHash());
    fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), 'junk');
    fs.mkdirSync(path.join(dir, 'frontend', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'frontend', 'dist', 'index.html'), 'built');
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'todos.db'), 'db');
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'mac');
    expect(computeStarterHash(dir, DOCKERFILE_PATH)).toBe(base);
  });

  it('changes when a starter file, a file name or the Dockerfile changes', () => {
    const dir = copyStarter();
    const base = computeStarterHash(dir, DOCKERFILE_PATH);

    fs.appendFileSync(path.join(dir, 'backend', 'server.js'), '\n// change\n');
    const edited = computeStarterHash(dir, DOCKERFILE_PATH);
    expect(edited).not.toBe(base);

    fs.writeFileSync(path.join(dir, 'frontend', 'extra.txt'), '');
    expect(computeStarterHash(dir, DOCKERFILE_PATH)).not.toBe(edited);

    const df = path.join(dir, 'Dockerfile.alt');
    fs.writeFileSync(df, fs.readFileSync(DOCKERFILE_PATH, 'utf8') + '\n# changed\n');
    const dir2 = copyStarter();
    expect(computeStarterHash(dir2, df)).not.toBe(computeStarterHash(dir2, DOCKERFILE_PATH));
  });
});
