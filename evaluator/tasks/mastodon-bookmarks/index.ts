/**
 * HIDDEN evaluator for task `mastodon-bookmarks` (docs/TASKS.md §4).
 *
 * Every check traces to a statement of benchmark/tasks/mastodon-bookmarks/spec/feature.md (§ in
 * each check's comment). Mandatory checks gate pass/fail via evaluator/score.ts.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvaluationResult } from '../../../runner/types.js';
import { runMastodonEvaluation, type EvaluateTaskOptions, type MastodonTaskDefinition } from '../mastodon-common/evaluate.js';
import type { ExpectedExample, RegressionSpec } from '../mastodon-common/rspec.js';
import { apiChecks } from './api-checks.js';
import { uiChecks } from './ui-checks.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

const BM_INDEX = 'spec/controllers/api/v1/bookmarks_controller_spec.rb';
const BM_STATUS = 'spec/controllers/api/v1/statuses/bookmarks_controller_spec.rb';
const IDX = 'Api::V1::BookmarksController GET #index';
const ST = 'Api::V1::Statuses::BookmarksController with an oauth token';

/** Upstream PR #7107 spec examples (hidden copies in ./upstream). */
export const EXPECTED_UPSTREAM: ExpectedExample[] = [
  { id: 'upstream.bookmarks_controller:index.without_token', file: BM_INDEX, fullDescription: `${IDX} without token returns http unauthorized`, mandatory: true },
  { id: 'upstream.bookmarks_controller:index.without_read_scope', file: BM_INDEX, fullDescription: `${IDX} with token without read scope returns http forbidden`, mandatory: true },
  { id: 'upstream.bookmarks_controller:index.without_resource_owner', file: BM_INDEX, fullDescription: `${IDX} with token without valid resource owner returns http unprocessable entity`, mandatory: true },
  { id: 'upstream.bookmarks_controller:index.owned_by_user', file: BM_INDEX, fullDescription: `${IDX} with token with read scope and valid resource owner shows bookmarks owned by the user`, mandatory: true },
  { id: 'upstream.bookmarks_controller:index.pagination_headers', file: BM_INDEX, fullDescription: `${IDX} with token with read scope and valid resource owner adds pagination headers if necessary`, mandatory: true },
  { id: 'upstream.bookmarks_controller:index.no_pagination_headers', file: BM_INDEX, fullDescription: `${IDX} with token with read scope and valid resource owner does not add pagination headers if not necessary`, mandatory: true },
  { id: 'upstream.statuses/bookmarks_controller:create.success', file: BM_STATUS, fullDescription: `${ST} POST #create returns http success`, mandatory: true },
  { id: 'upstream.statuses/bookmarks_controller:create.bookmarked', file: BM_STATUS, fullDescription: `${ST} POST #create updates the bookmarked attribute`, mandatory: true },
  { id: 'upstream.statuses/bookmarks_controller:create.json', file: BM_STATUS, fullDescription: `${ST} POST #create return json with updated attributes`, mandatory: true },
  { id: 'upstream.statuses/bookmarks_controller:destroy.success', file: BM_STATUS, fullDescription: `${ST} POST #destroy returns http success`, mandatory: true },
  { id: 'upstream.statuses/bookmarks_controller:destroy.bookmarked', file: BM_STATUS, fullDescription: `${ST} POST #destroy updates the bookmarked attribute`, mandatory: true },
];

/** Fast existing specs around the touched code (all exist at the checkpoint; JSON-only, no HTML/packs). */
export const REGRESSION: RegressionSpec[] = [
  'spec/controllers/api/v1/favourites_controller_spec.rb',
  'spec/controllers/api/v1/statuses/favourites_controller_spec.rb',
  'spec/controllers/api/v1/statuses/pins_controller_spec.rb',
  'spec/controllers/api/v1/statuses/mutes_controller_spec.rb',
  'spec/controllers/api/v1/statuses_controller_spec.rb',
  'spec/controllers/api/v1/timelines/home_controller_spec.rb',
  'spec/controllers/api/v1/accounts/statuses_controller_spec.rb',
  'spec/controllers/api/v1/apps_controller_spec.rb',
  'spec/models/status_spec.rb',
  'spec/models/favourite_spec.rb',
  'spec/models/concerns/account_interactions_spec.rb',
  'spec/services/remove_status_service_spec.rb',
].map((file) => ({ file, mandatory: true }));

export const TASK_DEFINITION: MastodonTaskDefinition = {
  taskId: 'mastodon-bookmarks',
  dir: DIR,
  upstreamFiles: [
    { src: 'spec/controllers/api/v1/bookmarks_controller_spec.rb', dest: BM_INDEX },
    { src: 'spec/controllers/api/v1/statuses/bookmarks_controller_spec.rb', dest: BM_STATUS },
  ],
  fabricators: [{ src: 'spec/fabricators/bookmark_fabricator.rb', dest: 'spec/fabricators/bookmark_fabricator.rb', name: 'bookmark' }],
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
