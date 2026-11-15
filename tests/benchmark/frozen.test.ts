import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const specDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../benchmark/spec');
const frozen = JSON.parse(fs.readFileSync(path.join(specDir, 'FROZEN.json'), 'utf8')) as {
  files: Record<string, string>;
};

function pngSize(file: string): { width: number; height: number } {
  const buf = fs.readFileSync(file);
  expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('frozen spec', () => {
  it('lists every spec file', () => {
    const present = fs
      .readdirSync(specDir)
      .filter((f) => f !== 'FROZEN.json' && !f.startsWith('.'))
      .sort();
    expect(Object.keys(frozen.files).sort()).toEqual(present);
    for (const required of [
      'requirements.md',
      'api-contract.yaml',
      'fixtures.json',
      'design-tokens.md',
      'design.png',
      'design-mobile.png',
    ]) {
      expect(present).toContain(required);
    }
  });

  it.each(Object.entries(frozen.files))('%s matches its frozen sha256', (name, hash) => {
    const actual = createHash('sha256').update(fs.readFileSync(path.join(specDir, name))).digest('hex');
    expect(actual).toBe(hash);
  });

  it('reference images have the contract viewport sizes', () => {
    expect(pngSize(path.join(specDir, 'design.png'))).toEqual({ width: 1280, height: 800 });
    expect(pngSize(path.join(specDir, 'design-mobile.png'))).toEqual({ width: 390, height: 844 });
  });

  it('visible spec does not leak hidden evaluation details', () => {
    for (const f of ['requirements.md', 'design-tokens.md', 'api-contract.yaml', 'fixtures.json']) {
      const text = fs.readFileSync(path.join(specDir, f), 'utf8');
      expect(text, f).not.toMatch(/holdout|evaluator|hidden test|reference-app/i);
    }
  });
});
