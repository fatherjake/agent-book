/**
 * HIDDEN evaluator for the holdout task `mastodon-filters` (docs/TASKS.md §4). Nothing from this
 * directory may reach the research agent.
 *
 * Every check traces to a statement of benchmark/tasks/mastodon-filters/spec/feature.md.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvaluationResult } from '../../../runner/types.js';
import { runMastodonEvaluation, type EvaluateTaskOptions, type MastodonTaskDefinition } from '../mastodon-common/evaluate.js';
import type { ExpectedExample, RegressionSpec } from '../mastodon-common/rspec.js';
import { apiChecks } from './api-checks.js';
import { uiChecks } from './ui-checks.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

const FC = 'spec/controllers/api/v1/filter_controller_spec.rb';
const FM = 'spec/lib/feed_manager_spec.rb';
const C = 'Api::V1::FiltersController';

/** Upstream PR #7905 spec examples (hidden copies in ./upstream). spec/models/custom_filter_spec.rb has no examples. */
export const EXPECTED_UPSTREAM: ExpectedExample[] = [
  { id: 'upstream.filter_controller:index.success', file: FC, fullDescription: `${C} GET #index returns http success`, mandatory: true },
  { id: 'upstream.filter_controller:create.success', file: FC, fullDescription: `${C} POST #create returns http success`, mandatory: true },
  { id: 'upstream.filter_controller:create.creates', file: FC, fullDescription: `${C} POST #create creates a filter`, mandatory: true },
  { id: 'upstream.filter_controller:show.success', file: FC, fullDescription: `${C} GET #show returns http success`, mandatory: true },
  { id: 'upstream.filter_controller:update.success', file: FC, fullDescription: `${C} PUT #update returns http success`, mandatory: true },
  { id: 'upstream.filter_controller:update.updates', file: FC, fullDescription: `${C} PUT #update updates the filter`, mandatory: true },
  { id: 'upstream.filter_controller:destroy.success', file: FC, fullDescription: `${C} DELETE #destroy returns http success`, mandatory: true },
  { id: 'upstream.filter_controller:destroy.removes', file: FC, fullDescription: `${C} DELETE #destroy removes the filter`, mandatory: true },
  {
    id: 'upstream.feed_manager:filter.home.irreversible_phrase',
    file: FM,
    fullDescription: 'FeedManager#filter? for home feed returns true if status contains irreversibly muted phrase',
    mandatory: true,
  },
];

/**
 * Fast existing specs around the touched code (all exist at the checkpoint; no HTML/packs). The
 * pre-existing examples of spec/lib/feed_manager_spec.rb (replaced by the upstream copy) are
 * aggregated into regression.lib/feed_manager.
 */
export const REGRESSION: RegressionSpec[] = [
  FM,
  'spec/models/invite_spec.rb',
  'spec/controllers/api/v1/timelines/home_controller_spec.rb',
  'spec/controllers/api/v1/timelines/public_controller_spec.rb',
  'spec/controllers/api/v1/notifications_controller_spec.rb',
  'spec/controllers/api/v1/statuses_controller_spec.rb',
  'spec/services/notify_service_spec.rb',
  'spec/services/fan_out_on_write_service_spec.rb',
  'spec/services/post_status_service_spec.rb',
  'spec/services/process_mentions_service_spec.rb',
].map((file) => ({ file, mandatory: true }));

export const TASK_DEFINITION: MastodonTaskDefinition = {
  taskId: 'mastodon-filters',
  dir: DIR,
  upstreamFiles: [
    { src: 'spec/controllers/api/v1/filter_controller_spec.rb', dest: FC },
    { src: 'spec/lib/feed_manager_spec.rb', dest: FM },
  ],
  fabricators: [{ src: 'spec/fabricators/custom_filter_fabricator.rb', dest: 'spec/fabricators/custom_filter_fabricator.rb', name: 'custom_filter' }],
  expectedUpstream: EXPECTED_UPSTREAM,
  regression: REGRESSION,
  rubyFiles: ['../mastodon-common/seed_helpers.rb', 'seed.rb', 'probe.rb'],
  seedScript: 'seed.rb',
  apiChecks,
  uiChecks,
};

export async function evaluateTask(opts: EvaluateTaskOptions): Promise<EvaluationResult> {
  return runMastodonEvaluation(TASK_DEFINITION, opts);
}
