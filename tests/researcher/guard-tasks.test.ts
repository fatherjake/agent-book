/**
 * Multi-task guard safeguards (researcher/config-guard.ts): banned terms, referenceDiffs and run patches in
 * the similarity corpus, docs/ limits; docs/ in config loading, the whitelist and the coding container.
 * FAKE data only.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditCodingRun, bannedTermRegex, findBannedTerm, GUARD_LIMITS, guardConfig, type GuardOptions } from '../../researcher/config-guard.js';
import { validateProposalFiles } from '../../researcher/whitelist.js';
import { hashConfig, loadConfigFromDir, snapshotConfig } from '../../runner/config.js';
import { FRUGAL_DOCS_DIR, installDocs, optTmpfsMounts, FRUGAL_OPT_TMPFS } from '../../runner/claude-code.js';
import { allBannedTerms } from '../../runner/tasks.js';

const rules = (r: { violations: { rule: string }[] }) => r.violations.map((v) => v.rule);

/** ~200 tokens of distinctive "upstream" Ruby, as it would appear in a hidden reference diff. */
const UPSTREAM_RUBY = `class Api::V1::Widgets::PinsController < Api::BaseController
  before_action -> { doorkeeper_authorize! :write, :'write:widgets' }
  before_action :require_user!
  before_action :set_widget_record, only: [:create, :destroy]
  respond_to :json

  def create
    current_account.widget_pins.find_or_create_by!(widget_record: @widget_record)
    render json: @widget_record, serializer: REST::WidgetSerializer, relationships: WidgetRelationshipsPresenter.new([@widget_record], current_user&.account_id)
  end

  def destroy
    pin = current_account.widget_pins.find_by(widget_record_id: @widget_record.id)
    pin&.destroy!
    render json: @widget_record, serializer: REST::WidgetSerializer, relationships: WidgetRelationshipsPresenter.new([@widget_record], current_user&.account_id, widget_pins_map: { @widget_record.id => false })
  end

  private

  def set_widget_record
    @widget_record = WidgetRecord.find(params[:widget_record_id])
    authorize @widget_record, :show?
  rescue Mastodon::NotPermittedError
    not_found
  end
end
`;

const toDiff = (path: string, text: string) => `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${text.split('\n').length} @@\n${text.split('\n').map((l) => `+${l}`).join('\n')}\n`;

describe('banned terms', () => {
  it('word-ish, case-insensitive matching across spaces, underscores, hyphens and camelCase', () => {
    const re = bannedTermRegex('CustomFilter');
    for (const s of ['CustomFilter', 'customfilter', 'custom_filter', 'custom filter', 'Custom-Filter', 'class CustomFilterKeyword']) expect(re.test(s)).toBe(true);
    expect(re.test('custom route filter')).toBe(false);
    expect(bannedTermRegex('keyword filter').test('Keyword_Filters')).toBe(true);
    expect(bannedTermRegex('filters_controller').test('app/controllers/api/v1/filters_controller.rb')).toBe(true);
    expect(findBannedTerm('add a Bookmarks column', ['bookmark'])).toEqual({ term: 'bookmark', match: 'Bookmark' });
    expect(findBannedTerm('a generic tip', ['bookmark'])).toBeNull();
  });

  it('rejects any config file (or file name) containing a banned term of any non-todo task', () => {
    const opts: GuardOptions = { corpus: false, bannedTerms: ['bookmark', 'custom_filter', 'phrase filter'] };
    expect(rules(guardConfig({ 'system-prompt.md': 'Be brief.' }, opts))).toEqual([]);
    expect(rules(guardConfig({ 'skills/x.md': 'Unbookmarking flow: see the toggle.' }, opts))).toEqual(['banned-term']);
    expect(rules(guardConfig({ 'docs/areas/filters.md': 'The CustomFilter model lives in app/models.' }, opts))).toEqual(['banned-term']);
    expect(rules(guardConfig({ 'CLAUDE.md': 'Phrase-Filter rules' }, opts))).toEqual(['banned-term']);
    expect(rules(guardConfig({ 'skills/bookmarks.md': 'Generic text.' }, opts))).toEqual(['banned-term']);
    expect(rules(guardConfig({ 'config.json': JSON.stringify({ claudeCode: { env: { X: 'bookmark' } } }) }, opts))).toContain('banned-term');
    // Disabled with an empty list.
    expect(rules(guardConfig({ 'skills/x.md': 'bookmark' }, { corpus: false, bannedTerms: [] }))).toEqual([]);
  });

  it('the shipped configs contain no banned term of the registry', () => {
    const terms = allBannedTerms();
    for (const dir of ['baseline', 'experiments/001', 'experiments/002', 'experiments/003']) {
      const r = guardConfig(join('configs', dir), { corpus: false, bannedTerms: terms });
      expect(rules(r).filter((x) => x === 'banned-term')).toEqual([]);
    }
  });
});

describe('similarity corpus: referenceDiffs and brownfield run patches', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'frugal-guard-tasks-'));
    mkdirSync(join(tmp, 'runs'), { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('a config reproducing the added lines of a hidden reference diff is rejected', () => {
    const diff = join(tmp, 'reference.diff');
    writeFileSync(diff, toDiff('app/controllers/api/v1/widgets/pins_controller.rb', UPSTREAM_RUBY));
    const opts: GuardOptions = { corpus: { runsDir: join(tmp, 'runs'), referenceAppDir: '/nonexistent', referenceDiffs: [diff] }, cacheFile: false, bannedTerms: [] };
    const skill = `# Pins\nUse this controller:\n\n\`\`\`ruby\n${UPSTREAM_RUBY.split('\n').slice(0, 16).join('\n')}\n\`\`\`\n`;
    const r = guardConfig({ 'docs/pins.md': skill }, opts);
    expect(rules(r)).toContain('similarity.app-code');
    expect(r.violations.find((v) => v.rule === 'similarity.app-code')!.detail).toMatch(/reference\.diff/);
    // Without the diff in the corpus the same text passes the similarity layer.
    const r2 = guardConfig({ 'docs/pins.md': skill }, { ...opts, corpus: { runsDir: join(tmp, 'runs'), referenceAppDir: '/nonexistent', referenceDiffs: [] } });
    expect(rules(r2)).not.toContain('similarity.app-code');
    // Only ADDED lines count: the same code as removed lines is not in the corpus.
    writeFileSync(diff, toDiff('x.rb', 'puts 1').replace(/^\+puts 1$/m, '+puts 1') + UPSTREAM_RUBY.split('\n').map((l) => `-${l}`).join('\n'));
    expect(rules(guardConfig({ 'docs/pins.md': skill }, opts))).not.toContain('similarity.app-code');
  });

  it("an earlier run's workspace.patch joins the corpus (except runs of the config itself)", () => {
    mkdirSync(join(tmp, 'runs', 'run-a'), { recursive: true });
    writeFileSync(join(tmp, 'runs', 'run-a', 'workspace.patch'), toDiff('app/x.rb', UPSTREAM_RUBY));
    writeFileSync(join(tmp, 'runs', 'run-a', 'run.json'), JSON.stringify({ configHash: 'abc' }));
    const files = { 'skills/x.md': `\`\`\`ruby\n${UPSTREAM_RUBY.split('\n').slice(4, 20).join('\n')}\n\`\`\`\n` };
    const base: GuardOptions = { corpus: { runsDir: join(tmp, 'runs'), referenceAppDir: '/nonexistent', referenceDiffs: [] }, cacheFile: false, bannedTerms: [] };
    expect(rules(guardConfig(files, base))).toContain('similarity.app-code');
    expect(rules(guardConfig(files, { ...base, excludeConfigHashes: ['abc'] }))).not.toContain('similarity.app-code');
  });

  it('the post-run audit compares the config with the added lines of the workspace patch', () => {
    const patch = join(tmp, 'workspace.patch');
    writeFileSync(patch, toDiff('app/controllers/pins_controller.rb', UPSTREAM_RUBY));
    const cfg = { ...loadConfigFromDir('configs/baseline', 'baseline'), skills: [{ name: 'x', content: UPSTREAM_RUBY }] };
    const a = auditCodingRun({ config: cfg, invocations: [], hookCounts: {}, patchFile: patch });
    expect(a.flagged).toBe(true);
    expect(a.reasons.join(' ')).toMatch(/workspace patch reproduces config content/);
    const b = auditCodingRun({ config: loadConfigFromDir('configs/baseline', 'baseline'), invocations: [], hookCounts: {}, patchFile: patch });
    expect(b.flagged).toBe(false);
  });
});

describe('docs/ config surface', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'frugal-docs-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const prose = (n: number) => ('The project keeps request handling in controllers and data access in models. ').repeat(Math.ceil(n / 78)).slice(0, n);
  const g = (files: Record<string, string>) => rules(guardConfig(files, { corpus: false, bannedTerms: [] }));

  it('limits: 32 KB per file, 256 KB and 64 files in total, not counted in the 40 KB always-loaded total', () => {
    expect(GUARD_LIMITS.docsFileBytes).toBe(32 * 1024);
    expect(GUARD_LIMITS.docsTotalBytes).toBe(256 * 1024);
    expect(g({ 'system-prompt.md': prose(6000), 'docs/a.md': prose(30 * 1024), 'docs/b.md': prose(30 * 1024) })).toEqual([]);
    expect(g({ 'docs/a.md': prose(33 * 1024) })).toEqual(['size.file']);
    const nine: Record<string, string> = {};
    for (let i = 0; i < 9; i++) nine[`docs/d${i}.md`] = prose(30 * 1024);
    expect(g(nine)).toEqual(['size.docs-total']);
    const many: Record<string, string> = {};
    for (let i = 0; i < 65; i++) many[`docs/n${i}.txt`] = 'short note';
    expect(g(many)).toEqual(['size.docs-count']);
    // A markdown file over 8 KB outside docs/ is still rejected.
    expect(g({ 'skills/a.md': prose(9 * 1024) })).toEqual(['size.file']);
  });

  it('proposals may add docs/<path> (claude-code only, <= 32 KB, nested up to 3 levels)', () => {
    const cc = { allowModelChange: false, backend: 'claude-code' as const, guard: false as const };
    expect(validateProposalFiles({ 'docs/areas/api/map.md': prose(20 * 1024) }, cc)).toEqual([]);
    expect(validateProposalFiles({ 'docs/a.md': prose(33 * 1024) }, cc).join(' ')).toMatch(/exceeds 32768 bytes/);
    expect(validateProposalFiles({ 'docs/../x.md': 'x' }, cc).join(' ')).toMatch(/outside the allowed modification surface/);
    expect(validateProposalFiles({ 'docs/a/b/c/d/e.md': 'x' }, cc).join(' ')).toMatch(/outside the allowed modification surface/);
    expect(validateProposalFiles({ 'docs/a.md': 'x' }, { allowModelChange: false, backend: 'api', guard: false }).join(' ')).toMatch(/only used by configs with backend "claude-code"/);
  });

  it('loads docs/ into config.docs, snapshots it, and leaves hashes of configs without docs unchanged', () => {
    const before = hashConfig(loadConfigFromDir('configs/baseline', 'baseline'));
    expect(loadConfigFromDir('configs/baseline', 'baseline').docs).toBeUndefined();
    const snap = join(dir, 'cfg');
    snapshotConfig(loadConfigFromDir('configs/baseline', 'baseline'), snap);
    mkdirSync(join(snap, 'docs', 'areas'), { recursive: true });
    writeFileSync(join(snap, 'docs', 'areas', 'map.md'), '# Map\nControllers live in app/controllers.\n');
    writeFileSync(join(snap, 'docs', 'index.txt'), 'see areas/map.md\n');
    const cfg = loadConfigFromDir(snap, 'baseline');
    expect(cfg.docs).toEqual([
      { path: 'areas/map.md', content: '# Map\nControllers live in app/controllers.\n' },
      { path: 'index.txt', content: 'see areas/map.md\n' },
    ]);
    expect(hashConfig(cfg)).not.toBe(before);
    const snap2 = join(dir, 'cfg2');
    snapshotConfig(cfg, snap2);
    expect(readFileSync(join(snap2, 'docs', 'areas', 'map.md'), 'utf8')).toMatch(/Controllers/);
    expect(hashConfig(loadConfigFromDir(snap2, 'baseline'))).toBe(hashConfig(cfg));
  });

  it('installs docs root-owned and read-only at /opt/frugal/docs; mounts per /opt/frugal layout', async () => {
    expect(optTmpfsMounts({}, 'single')).toEqual([]);
    expect(optTmpfsMounts({ docs: [{ path: 'a.md', content: 'x' }] }, 'single')).toEqual([FRUGAL_OPT_TMPFS]);
    const split = optTmpfsMounts({ bin: [{ name: 'check', content: '#!/bin/sh\n' }], docs: [{ path: 'a.md', content: 'x' }] }, 'split');
    expect(split.map((m) => m.split(':')[0])).toEqual(['/opt/frugal/bin', '/opt/frugal/libexec', '/opt/frugal/docs']);
    expect(split.find((m) => m.startsWith('/opt/frugal/docs'))).toMatch(/noexec/);
    const writes: { path: string; user?: string }[] = [];
    const cmds: { cmd: string; user?: string }[] = [];
    const sb = {
      containerId: 'fake',
      async writeFileBuffer(path: string, _c: Buffer, o?: { user?: string }) {
        writes.push({ path, user: o?.user });
      },
      async exec(cmd: string, o?: { user?: string }) {
        cmds.push({ cmd, user: o?.user });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const cfg = { ...loadConfigFromDir('configs/baseline', 'baseline'), docs: [{ path: 'areas/map.md', content: '# Map' }] };
    await installDocs(sb, cfg, 'split');
    expect(writes).toEqual([{ path: `${FRUGAL_DOCS_DIR}/areas/map.md`, user: 'root' }]);
    expect(cmds[0].user).toBe('root');
    expect(cmds[0].cmd).toMatch(/chmod 0444/);
    expect(cmds[0].cmd).toMatch(/chmod 0555/);
    expect(cmds[0].cmd).not.toMatch(/chmod 0555 \/opt\/frugal$/); // split: /opt/frugal belongs to the image
    cmds.length = 0;
    await installDocs(sb, cfg, 'single');
    expect(cmds[0].cmd).toMatch(/chmod 0555 \/opt\/frugal$/);
  });
});
