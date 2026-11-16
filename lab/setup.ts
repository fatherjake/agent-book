/**
 * Setup and repo evaluation: everything the repo page shows, measured, saved as a new profile version.
 *
 *   1. clone the repo at the pinned commit, detect its stack
 *   2. build (or reuse) the test image
 *   3. build the skills overlay (the repo's instruction files + the links its setup asks for)
 *   4. in a fresh hardened container with the overlay: run the repo's own commands (tests, build, lint,
 *      app + health check) and record each result
 *   5. scan the instruction sources and the skills (frontmatter: name, description)
 *   6. activation probes (optional, costs tokens): a short task under each candidate recipe, capped at a
 *      few model calls; "fired" = the agent loaded the skill. The most reliable recipe is used by sessions.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../runner/config.js';
import { resultsDir } from '../runner/env.js';
import { logger } from '../runner/logger.js';
import { runCodingAgent } from '../runner/run.js';
import { ensureTaskImage, getTask as getBenchmarkTask } from '../runner/tasks.js';
import { TinyEvalContainer } from '../evaluator/tasks/tiny-common/container.js';
import type { LabDb } from './db.js';
import { getRepo, type LabRepo } from './repos.js';
import { LAB_CONFIG, newLabRunId, skillsFired } from './run.js';
import { registerRepo, pool } from './session.js';
import { ensureClone, overlayPatch } from './skills.js';

const log = logger('lab.setup');

type StepStatus = 'ok' | 'warn' | 'fail';
interface Step {
  label: string;
  status: StepStatus;
  detail: string;
  durationMs: number;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** The line that summarises a test run, else the last non-empty line. */
const summaryLine = (s: string) => {
  const clean = s.replace(/\x1b\[[0-9;]*m/g, '');
  // Most specific first: vitest's "Tests N passed" before its "Test Files" line, pytest, vite, ruff.
  for (const re of [/^\s*Tests\s+\d+ passed.*$/m, /^.*\b\d+ (passed|failed)\b.*$/m, /^.*built in [\d.]+m?s.*$/m, /^.*\d+ files? would be reformatted.*$/m]) {
    const m = clean.match(re);
    if (m) return m[0].trim().replace(/\s+/g, ' ').slice(0, 160);
  }
  return lastLine(clean);
};
const lastLine = (s: string) =>
  s
    .replace(/\x1b\[[0-9;]*m/g, '')
    .trim()
    .split('\n')
    .filter((l) => l.trim())
    .slice(-1)[0]
    ?.trim()
    .slice(0, 160) ?? '';

/** name + description of every SKILL.md under the skills folder. */
function scanSkills(clone: string): { name: string; description: string; path: string }[] {
  const root = join(clone, '.agents', 'skills');
  if (!existsSync(root)) return [];
  const out: { name: string; description: string; path: string }[] = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    const f = join(root, d.name, 'SKILL.md');
    if (!d.isDirectory() || !existsSync(f)) continue;
    const fm = readFileSync(f, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const get = (k: string) => (fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1] ?? '').replace(/^"|"$/g, '').replace(/\\"/g, '"').trim();
    out.push({ name: get('name') || d.name, description: get('description'), path: `.agents/skills/${d.name}/SKILL.md` });
  }
  return out;
}

function splitDescription(desc: string): { role: string; trigger: string } {
  const sentences = desc.split(/(?<=\.)\s+/);
  const trig = sentences.filter((s) => /^(Use|Not for|Skip)\b/i.test(s)).join(' ');
  const role = sentences.filter((s) => !/^(Use|Not for|Skip)\b/i.test(s)).join(' ');
  return { role: role || desc, trigger: trig || '—' };
}

export interface SetupOptions {
  /** Probe runs per recipe (0 = skip activation probes). */
  probes: number;
  concurrency: number;
  signal?: AbortSignal;
}

export async function runSetup(db: LabDb, repoId: string, opts: SetupOptions): Promise<number> {
  const repo: LabRepo = registerRepo(db, repoId);
  const steps: Step[] = [];
  const step = async <T>(label: string, fn: () => Promise<{ value: T; detail: string; status?: StepStatus }>): Promise<T | null> => {
    const t0 = Date.now();
    try {
      const r = await fn();
      steps.push({ label, status: r.status ?? 'ok', detail: r.detail, durationMs: Date.now() - t0 });
      log.info('setup step', { label, status: r.status ?? 'ok', detail: r.detail });
      return r.value;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 400);
      steps.push({ label, status: 'fail', detail: msg, durationMs: Date.now() - t0 });
      log.error('setup step failed', { label, error: msg });
      return null;
    }
  };

  const clone = await step('Clone repository', async () => {
    const dir = ensureClone(repo.skills);
    return { value: dir, detail: `${repo.skills.url.replace(/^https:\/\/github.com\//, '').replace(/\.git$/, '')} @ ${repo.skills.commit.slice(0, 7)}` };
  });
  await step('Detect stack', async () => {
    if (!clone) throw new Error('no clone');
    const parts: string[] = [];
    const py = existsSync(join(clone, 'pyproject.toml')) ? readFileSync(join(clone, 'pyproject.toml'), 'utf8').match(/requires-python\s*=\s*"([^"]+)"/)?.[1] : null;
    if (py) parts.push(`Python ${py}${existsSync(join(clone, 'uv.lock')) ? ' + uv (uv.lock)' : ''}`);
    for (const lock of ['package-lock.json', 'ui/package-lock.json']) if (existsSync(join(clone, lock))) parts.push(`Node + npm (${lock})`);
    return { value: null, detail: parts.join(' · ') || 'unknown' };
  });
  const bench = getBenchmarkTask(repo.tasks[0].benchmarkTask);
  const image = await step('Build test image', async () => {
    const info = await ensureTaskImage(bench);
    const { execFileSync } = await import('node:child_process');
    const size = execFileSync('docker', ['images', '--format', '{{.Size}}', info.baseImage], { encoding: 'utf8' }).trim().split('\n')[0];
    return { value: info.baseImage, detail: `${size} · dependencies baked in, runs offline` };
  });
  const overlay = await step('Install skills', async () => {
    const p = overlayPatch(repo.skills);
    const files = (p.match(/^diff --git/gm) ?? []).length;
    return { value: p, detail: `${files - repo.skills.links.length} skill files${repo.skills.links.map((l) => ` · linked ${l.link} → ${l.target}`).join('')}` };
  });

  // ---- the repo's own commands, in a hardened container with the skills installed ------------------------
  const commands: { purpose: string; command: string; source: string; verified: boolean; required: boolean; result: string }[] = [];
  if (image && overlay) {
    let c: TinyEvalContainer | null = null;
    await step('Run the repo commands', async () => {
      c = await TinyEvalContainer.launch({ runId: `setup-${Date.now()}`, image, sandbox: { ...bench.sandbox }, taskId: bench.id });
      let r = await c.exec('/opt/frugal/task/services start', { timeoutMs: 120_000 });
      if (r.code !== 0) throw new Error(`services start: ${lastLine(r.stderr || r.stdout)}`);
      await c.writeFile('/tmp/overlay.patch', overlay);
      r = await c.exec(`git apply --binary /tmp/overlay.patch && git add -A && git -c user.name=lab -c user.email=lab@localhost commit -qm overlay`, { timeoutMs: 60_000 });
      if (r.code !== 0) throw new Error(`overlay: ${lastLine(r.stderr || r.stdout)}`);
      for (const cmd of repo.commands) {
        const t0 = Date.now();
        const res = await c.exec(cmd.command, { timeoutMs: 600_000 });
        const secs = ((Date.now() - t0) / 1000).toFixed(0);
        const ok = res.code === 0;
        const tail = cmd.purpose.startsWith('Health') ? lastLine(res.stdout).slice(0, 60) : summaryLine(res.stdout + '\n' + res.stderr);
        const required = cmd.required !== false;
        commands.push({
          purpose: cmd.purpose,
          command: cmd.command,
          source: cmd.source,
          verified: ok,
          required,
          result: ok ? `${tail || 'ok'} (${secs}s)` : `${required ? '' : 'fails before any change: '}${summaryLine(res.stdout + '\n' + res.stderr) || `exit ${res.code}`}`,
        });
      }
      const failed = commands.filter((x) => !x.verified && x.required);
      const preexisting = commands.filter((x) => !x.verified && !x.required);
      return {
        value: null,
        status: failed.length ? 'fail' : preexisting.length ? 'warn' : 'ok',
        detail: failed.length
          ? `${failed.length} required command(s) failed: ${failed.map((x) => x.purpose).join(', ')}`
          : `${commands.length - preexisting.length} of ${commands.length} commands pass with the skills installed${preexisting.length ? `; pre-existing failure, graded relative to this baseline: ${preexisting.map((x) => x.purpose).join(', ')}` : ''}`,
      };
    });
    await (c as TinyEvalContainer | null)?.stop().catch(() => undefined);
  }

  // ---- instruction sources and skills ---------------------------------------------------------------------
  const surfaces: { path: string; what: string; loading: 'auto' | 'wired' | 'not-loaded'; note: string }[] = [];
  const skills: { name: string; role: string; usedFor: string; trigger: string }[] = [];
  const conflicts: { issue: string; handling: string }[] = [];
  await step('Evaluate instructions and skills', async () => {
    if (!clone) throw new Error('no clone');
    const read = (p: string) => (existsSync(join(clone, p)) ? readFileSync(join(clone, p), 'utf8') : '');
    const claude = read('CLAUDE.md');
    const agents = read('AGENTS.md');
    if (claude) surfaces.push({ path: 'CLAUDE.md', what: lastLine(claude.split('\n').slice(0, 4).join('\n')) || 'project instructions', loading: 'auto', note: 'Loaded by Claude Code every session' });
    if (agents)
      surfaces.push({
        path: 'AGENTS.md',
        what: 'Shared instructions: commands, how to work, git rules',
        loading: 'auto',
        note: /AGENTS\.md/.test(claude) ? 'Read because CLAUDE.md tells the agent to (one extra read per run)' : 'Not referenced by CLAUDE.md; the agent may never read it',
      });
    const found = scanSkills(clone);
    if (found.length) surfaces.push({ path: '.agents/skills/', what: `${found.length} skills (${found.slice(0, 4).map((s) => s.name).join(', ')}, …)`, loading: repo.skills.links.length ? 'wired' : 'not-loaded', note: repo.skills.links.length ? `Claude Code reads .claude/skills/; setup links it, as CLAUDE.md asks` : 'Not linked' });
    const mcp = read('.agents/mcp.json');
    if (mcp) {
      let n = 0;
      try {
        n = Object.keys(JSON.parse(mcp).mcpServers ?? {}).length;
      } catch {
        /* unparsable */
      }
      surfaces.push({ path: '.agents/mcp.json', what: `MCP config (${n} server${n === 1 ? '' : 's'})`, loading: 'not-loaded', note: n ? 'Servers need the network; the sandbox has none' : 'Empty: nothing to load' });
    }
    for (const d of ['.cursor', '.codex']) if (existsSync(join(clone, d))) surfaces.push({ path: `${d}/`, what: 'Another agent’s config', loading: 'not-loaded', note: 'Not read by Claude Code' });
    for (const s of found) {
      const { role, trigger } = splitDescription(s.description);
      const usedFor = /feature|bug|refactor/i.test(s.description) ? 'feature · fix · refactor' : /verif/i.test(s.name) ? 'verification' : /task-|review/.test(s.name) ? 'planning / long runs' : 'other';
      skills.push({ name: s.name, role: role.slice(0, 160), usedFor, trigger: trigger.slice(0, 200) });
    }
    if (/branch/i.test(agents)) conflicts.push({ issue: 'AGENTS.md asks to work on a branch and not commit to main', handling: 'Harmless: the graded result is the diff against the starting commit, wherever the agent commits' });
    if (found.some((s) => s.name === 'task-progress')) conflicts.push({ issue: 'task-progress writes .agents/tasks/<task>/', handling: 'Excluded from the graded diff, so it never counts as stray files' });
    if (mcp) conflicts.push({ issue: 'MCP config in .agents/mcp.json', handling: 'Not linked: runs use no MCP servers' });
    return { value: null, detail: `${surfaces.length} instruction sources, ${found.length} skills` };
  });

  // ---- activation probes ------------------------------------------------------------------------------------
  const probes: { recipe: string; id: string; example: string; fired: number; total: number; chosen: boolean }[] = [];
  let chosenId: string | null = null;
  const previous = db.latestProfile(repoId);
  if (opts.probes === 0 && previous?.activation?.probes?.length) {
    probes.push(...previous.activation.probes);
    chosenId = previous.activation.chosenId ?? null;
    steps.push({ label: 'Measure skill activation', status: 'ok', detail: `reused from profile v${previous.version} (no new probes)`, durationMs: 0 });
  } else if (opts.probes > 0 && overlay) {
    await step('Measure skill activation', async () => {
      for (const r of repo.recipes) probes.push({ recipe: r.label, id: r.id, example: r.wrap(repo.probeTask).slice(0, 140), fired: 0, total: 0, chosen: false });
      const jobs = repo.recipes.flatMap((r) => Array.from({ length: opts.probes }, (_, k) => ({ r, k })));
      await pool(jobs, opts.concurrency, async ({ r, k }) => {
        const runId = `${newLabRunId()}-probe`;
        try {
          await runCodingAgent({
            config: loadConfig(LAB_CONFIG),
            runId,
            seed: 1000 + k,
            task: bench,
            taskPrompt: r.wrap(repo.probeTask),
            workspaceOverlay: overlay,
            limitsOverride: { maxModelCalls: 4 },
            signal: opts.signal,
          });
          const fired = skillsFired(join(resultsDir(), 'runs', runId), repo.skillMarkers);
          const p = probes.find((x) => x.id === r.id)!;
          p.total++;
          if (fired) p.fired++;
        } catch (e) {
          log.warn('probe failed', { recipe: r.id, error: String(e) });
        }
      });
      // Most reliable; ties go to the earlier (simpler) recipe.
      let best = probes[0];
      for (const p of probes) if (p.total && p.fired / p.total > (best.total ? best.fired / best.total : -1)) best = p;
      best.chosen = true;
      chosenId = best.id;
      return { value: null, detail: `${repo.recipes.length} recipes × ${opts.probes} probe runs; best: ${best.recipe} (${best.fired}/${best.total})` };
    });
  }
  const tasks = db.listTasks(repoId);
  steps.push({ label: 'Task suite', status: tasks.some((t) => t.approved) ? 'ok' : 'warn', detail: `${tasks.filter((t) => !t.heldOut).length} tasks + ${tasks.filter((t) => t.heldOut).length} held out · ${tasks.filter((t) => t.approved).length} approved`, durationMs: 0 });

  const plain = probes.find((p) => p.id === 'plain');
  const chosen = probes.find((p) => p.chosen);
  const finding = !probes.length
    ? `Activation not measured yet (run \`npm run lab -- setup --probes 3\`). Sessions use: ${repo.recipes.find((r) => r.id === repo.defaultRecipe)!.label}.`
    : plain && chosen && chosen.id !== 'plain'
      ? `With the task prompt alone the skills fired in ${plain.fired}/${plain.total} probes; with "${chosen.recipe.replace(/^Prompt \+ /, '').replace(/"/g, '')}" they fired in ${chosen.fired}/${chosen.total}, so sessions use it. Making the skills fire without being named is a candidate suggestion.`
      : `The skills fire reliably${chosen ? ` (${chosen.fired}/${chosen.total})` : ''} with the task prompt alone.`;

  const version = db.saveProfile(repoId, {
    evaluatedAt: new Date().toISOString(),
    setup: steps,
    commands,
    surfaces,
    skills,
    activation: { probes, finding, probeTask: `Probe task (${repo.probeTask}) capped at 4 model calls per run; "fired" = the agent loaded a repo skill.`, chosenId },
    conflicts,
  });
  return version;
}

export { getRepo };
