/**
 * image.builder of task tiny-depth (benchmark/tasks/tiny-depth/task.json), loaded by runner/tasks.ts.
 * Every tiny-* task shares the same images; all logic lives in benchmark/tasks/tiny/image.ts.
 */
import { ensureRunnerImages, type CcImageInfo } from '../../tiny/image.js';

/** { image: coding image (Claude Code layer, or the task image for backend 'api'), imageId, starterHash, baseImage }. */
export function ensureTaskImage(opts: { backend?: 'api' | 'claude-code'; force?: boolean; onLog?: (s: string) => void } = {}): Promise<CcImageInfo> {
  return ensureRunnerImages(opts);
}
