/** Temp task registries for tests (FAKE tasks; no images, no evaluators). */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function brownfieldDef(id = 'mastodon-x', o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Fake brownfield task ${id}`,
    kind: 'brownfield',
    promptFile: 'prompt.md',
    specDir: 'spec',
    image: { builder: `benchmark/tasks/${id}/docker/image.ts` },
    workspace: { path: '/workspace', snapshot: 'git-diff' },
    sandbox: { cpus: 4, memory: '6g', pidsLimit: 2048, extraVolumes: ['/data'], extraTmpfs: ['/run/postgresql:rw,nosuid,size=1m,uid=1000'] },
    limits: { maxRuntimeSec: 3600, maxModelCalls: 400 },
    evaluator: `evaluator/tasks/${id}/index.ts`,
    browserAgent: 'none',
    minPassRate: 0.6,
    bannedTerms: ['bookmark'],
    referenceDiffs: [`evaluator/tasks/${id}/reference.diff`],
    ...o,
  };
}

/** A temp repo root with benchmark/tasks/<id>/{task.json,prompt.md,spec/}. */
export function makeTaskRepo(defs: Record<string, unknown>[]): { root: string; tasksDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'frugal-tasks-'));
  const tasksDir = join(root, 'benchmark', 'tasks');
  for (const d of defs) {
    const dir = join(tasksDir, String(d.id));
    mkdirSync(join(dir, 'spec'), { recursive: true });
    writeFileSync(join(dir, 'task.json'), JSON.stringify(d, null, 2));
    writeFileSync(join(dir, 'prompt.md'), `Implement the feature of ${d.id}.\n`);
    writeFileSync(join(dir, 'spec', 'feature.md'), '# Feature\n');
  }
  return { root, tasksDir };
}

