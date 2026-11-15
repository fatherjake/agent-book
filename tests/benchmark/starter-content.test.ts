import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STARTER_DIR, listStarterFiles } from '../../benchmark/docker/image.js';

const sourceFiles = listStarterFiles().filter((f) => !/package(-lock)?\.json$/.test(f));
const read = (rel: string) => fs.readFileSync(path.join(STARTER_DIR, rel), 'utf8');

describe('starter scaffold', () => {
  it('has the expected minimal layout', () => {
    const files = listStarterFiles();
    for (const f of [
      'package.json',
      'package-lock.json',
      'frontend/index.html',
      'frontend/vite.config.js',
      'frontend/src/main.jsx',
      'backend/server.js',
    ]) {
      expect(files).toContain(f);
    }
    expect(fs.existsSync(path.join(STARTER_DIR, 'node_modules'))).toBe(false);
  });

  it('declares build/start scripts and exactly the allowed dependencies', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts.build).toMatch(/vite build/);
    expect(pkg.scripts.start).toBe('node backend/server.js');
    expect(Object.keys(pkg.dependencies).sort()).toEqual(
      ['@fontsource/inter', '@vitejs/plugin-react', 'better-sqlite3', 'express', 'react', 'react-dom', 'vite'].sort(),
    );
    expect(pkg.devDependencies ?? {}).toEqual({});
    expect(pkg.workspaces).toBeUndefined();
    const lock = JSON.parse(read('package-lock.json'));
    expect(lock.packages[''].dependencies).toEqual(pkg.dependencies);
  });

  it('contains no todo implementation', () => {
    const forbidden: [RegExp, string][] = [
      [/\/api\/todos/i, 'todo API route'],
      [/create\s+table/i, 'SQL schema'],
      [/better-sqlite3/, 'database code'],
      [/\b(useState|useEffect|useReducer)\b/, 'React state'],
      [/\bfetch\(/, 'API calls'],
      [/aria-label|role=/, 'accessibility markup of the todo UI'],
      [/\b(app|router)\.(get|post|patch|put|delete)\(/i, 'API handlers'],
      [/checkbox|completed|filter/i, 'todo UI'],
    ];
    for (const rel of sourceFiles) {
      const text = read(rel);
      for (const [re, what] of forbidden) {
        expect(re.test(text), `${rel} contains ${what} (${re})`).toBe(false);
      }
    }
  });

  it('backend answers /api with 501 and the frontend is a placeholder', () => {
    expect(read('backend/server.js')).toMatch(/status\(501\)/);
    expect(read('frontend/src/main.jsx')).toMatch(/not implemented/i);
  });
});
