/**
 * image.builder of task mastodon-bookmarks (benchmark/tasks/mastodon-bookmarks/task.json), loaded by
 * runner/tasks.ts. All logic lives in benchmark/tasks/mastodon/image.ts (see its README).
 */
import { ensureRunnerImages, type CcImageInfo } from '../../mastodon/image.js';

export const TASK_ID = 'mastodon-bookmarks';

/** { image: coding image (Claude Code layer, or the task image for backend 'api'), imageId, starterHash, baseImage }. */
export function ensureTaskImage(opts: { backend?: 'api' | 'claude-code'; force?: boolean; onLog?: (s: string) => void } = {}): Promise<CcImageInfo> {
  return ensureRunnerImages(TASK_ID, opts);
}
