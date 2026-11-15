/**
 * Named mock-provider scripts for INFRASTRUCTURE TESTS (`--provider mock --mock-script <name>`).
 * Results produced with any of them are flagged [MOCK] and can never be promoted.
 *
 *  - default        the runner's default mock script: writes /workspace/MOCK_RUN.txt and finishes.
 *                   Expected outcome: a clean app failure (the starter alone doesn't start).
 *  - reference-app  pushes the hidden reference implementation (evaluator/reference-app, without
 *                   node_modules/dist/data) through write_file tool calls, exercising the whole
 *                   pipeline (coding container → snapshot → eval container → checks → DB).
 *                   Expected outcome: deterministic + visual checks pass. It proves the plumbing
 *                   works, NOT that any model can build the app.
 */
import { join } from 'node:path';
import type { MockScript } from '../runner/providers/mock.js';
import { REPO_ROOT } from '../runner/env.js';

export const MOCK_SCRIPT_NAMES = ['default', 'reference-app'] as const;
export type MockScriptName = (typeof MOCK_SCRIPT_NAMES)[number];

export function resolveMockScript(name: string): MockScript {
  switch (name) {
    case 'default':
      return { type: 'default' };
    case 'reference-app':
      return { type: 'write-files-from-dir', dir: join(REPO_ROOT, 'evaluator', 'reference-app'), filesPerTurn: 6 };
    default:
      throw new Error(`unknown mock script '${name}' (choices: ${MOCK_SCRIPT_NAMES.join(', ')})`);
  }
}
