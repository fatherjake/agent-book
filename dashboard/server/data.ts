/**
 * Read-only data layer for the dashboard. All SQL lives in storage/db.ts; this
 * file only reshapes its query helpers into the JSON the UI wants, and reads
 * artifact files (traces, screenshots, config dirs) from disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Db, openDb, openDbReadOnly, SCHEMA_VERSION } from '../../storage/db.js';
import type { ExperimentListItem, RunRow as DbRunRow, EvaluationRow, ArtifactRow } from '../../storage/db.js';
import type {
  ArtifactRef,
  Charts,
  ConfigSummary,
  EvaluationView,
  ExperimentDetail,
  ExperimentRow,
  Overview,
  RunDetail,
  RunRow,
  TokenBreakdownRow,
  TraceEntry,
} from '../src/api-types.js';
import { diffDirs } from './diff.js';

export interface DashboardData {
  overview(): Overview;
  experiments(): ExperimentRow[];
  experiment(id: string): ExperimentDetail | null;
  run(id: string): RunDetail | null;
  charts(): Charts;
  close(): void;
  readonly warnings: string[];
}

export interface OpenResult {
  db: Db;
  warnings: string[];
}

/**
 * Open the results DB strictly read-only (no migrations, no WAL switch, query_only on).
 * A missing DB file yields an empty in-memory DB so the dashboard still starts.
 */
export function openReadOnlyDb(file: string): OpenResult {
  const warnings: string[] = [];
  if (!fs.existsSync(file)) {
    warnings.push(`Database ${file} does not exist yet; showing an empty dashboard.`);
    return { db: openDb(':memory:', { experimentsJsonl: null }), warnings };
  }
  const db = openDbReadOnly(file);
  const version = db.schemaVersion();
  if (version !== SCHEMA_VERSION) {
    warnings.push(`Database schema version ${version} differs from storage/db.ts version ${SCHEMA_VERSION}; some data may be missing.`);
  }
  return { db, warnings };
}

const TRACE_MAX_LINES = 3000;
const TRACE_MAX_BYTES = 8 * 1024 * 1024;
const VERIFIED_OUTCOMES = new Set(['promoted', 'baseline', 'not_better']);

export interface DataOptions {
  dbPath: string;
  /** Repo root: DB artifact paths are relative to it. */
  repoRoot: string;
  /** results/ directory served at /artifacts. */
  resultsDir: string;
}

export function createDashboardData(opts: DataOptions): DashboardData {
  const { db, warnings } = openReadOnlyDb(opts.dbPath);
  const { repoRoot, resultsDir } = opts;

  const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(repoRoot, p));
  const artifactUrl = (p: string | null | undefined): string | null => {
    if (!p) return null;
    const rel = path.relative(resultsDir, abs(p));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return '/artifacts/' + rel.split(path.sep).map(encodeURIComponent).join('/');
  };
  const displayPath = (p: string) => {
    const rel = path.relative(repoRoot, abs(p));
    return rel.startsWith('..') ? p : rel.split(path.sep).join('/');
  };

  const ACTIVE = new Set(['pending', 'running', 'verifying']);
  /** One token number per experiment: the researcher's summary median when present, else storage's aggregate. */
  const tokensOf = (e: ExperimentListItem): number | null => e.summary?.medianTokens ?? e.medianTokens;

  /** Experiment passed = verified (summary meets quality); null while still in progress or never evaluated. */
  function experimentPassed(e: ExperimentListItem): boolean | null {
    if (ACTIVE.has(e.status)) return null;
    if (e.summary) return Boolean(e.summary.meetsQualityRequirements);
    if (e.quickPassed !== null) return e.quickPassed;
    return e.passRate === null ? null : e.passRate === 1;
  }

  function isVerified(e: ExperimentListItem): boolean {
    return Boolean(e.summary?.meetsQualityRequirements) && (e.summary?.runs ?? 0) > 1 && (e.outcome === null || VERIFIED_OUTCOMES.has(e.outcome));
  }

  /** Finished-run counts per experiment (all phases), from storage's listRuns(). */
  function runStats(): Map<string, { runs: number; passes: number }> {
    const m = new Map<string, { runs: number; passes: number }>();
    for (const r of db.listRuns()) {
      if (!r.experimentId || r.status === 'running') continue;
      const g = m.get(r.experimentId) ?? { runs: 0, passes: 0 };
      g.runs++;
      if (r.passed) g.passes++;
      m.set(r.experimentId, g);
    }
    return m;
  }

  function configSummary(e: ExperimentListItem, verified: boolean): ConfigSummary {
    return {
      configId: e.candidateConfigId ?? '(none)',
      experimentId: e.id,
      runs: e.summary?.runs ?? e.runsTotal,
      passes: e.summary?.passes ?? Math.round((e.passRate ?? 0) * e.runsTotal),
      passRate: e.summary?.passRate ?? e.passRate ?? 0,
      medianTokens: tokensOf(e),
      medianVisualScore: e.medianVisualScore ?? (e.summary?.medianVisualScore || null),
      verified,
      isMock: e.anyMock,
    };
  }

  /** Best verified among mock experiments — never eligible, only displayed with a badge. */
  function mockBestOf(list: ExperimentListItem[]): ExperimentListItem | null {
    let best: ExperimentListItem | null = null;
    for (const e of list) {
      if (!e.anyMock || !isVerified(e)) continue;
      const t = tokensOf(e);
      if (t === null) continue;
      if (!best || t < (tokensOf(best) ?? Infinity)) best = e;
    }
    return best;
  }

  interface RowCtx {
    realBest: number | null;
    mockBest: number | null;
    stats: Map<string, { runs: number; passes: number }>;
  }

  function rowCtx(list: ExperimentListItem[]): RowCtx {
    const mb = mockBestOf(list);
    return { realBest: db.getBestVerified()?.medianTokens ?? null, mockBest: mb ? tokensOf(mb) : null, stats: runStats() };
  }

  function toRow(e: ExperimentListItem, ctx: RowCtx): ExperimentRow {
    const tokens = tokensOf(e);
    // Real rows compare to the real best; mock rows fall back to the mock best when no real best exists.
    const ref = ctx.realBest ?? (e.anyMock ? ctx.mockBest : null);
    let improvement = tokens !== null && ref ? ((ref - tokens) / ref) * 100 : null;
    if (improvement !== null && Math.abs(improvement) < 1e-9) improvement = 0;
    const st = ctx.stats.get(e.id) ?? { runs: 0, passes: 0 };
    return {
      id: e.id,
      createdAt: e.createdAt,
      provider: e.provider,
      model: e.model,
      configId: e.candidateConfigId ?? '(none)',
      parentConfigId: e.parentConfigId,
      status: e.status,
      outcome: e.outcome,
      hypothesis: e.hypothesis,
      passed: experimentPassed(e),
      runs: st.runs,
      passes: st.passes,
      passRate: st.runs ? st.passes / st.runs : null,
      medianTokens: tokens,
      costUsd: e.totalCostUsd,
      medianDurationMs: e.summary?.medianDurationMs ?? e.medianDurationMs,
      visualScore: e.medianVisualScore ?? (e.summary?.medianVisualScore || null),
      improvementVsBestPct: improvement,
      isMock: e.anyMock,
      noBrowserAgent: e.anyBrowserAgentSkipped,
    };
  }

  function runRow(r: DbRunRow, evals?: EvaluationRow[]): RunRow {
    const ev = (evals ?? db.listEvaluations(r.runId)).find((x) => x.suite === r.suite) ?? (evals ?? [])[0];
    return {
      id: r.runId,
      experimentId: r.experimentId,
      configId: r.configId,
      seed: r.seed,
      status: r.status + (r.phase ? ` (${r.phase})` : ''),
      passed: r.passed,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.durationMs,
      totalTokens: r.totalTokens,
      costUsd: r.costUsd,
      toolCalls: r.toolCalls,
      visualScore: ev?.visualScore ?? null,
      failureReason: r.failureReason,
      imageId: r.imageId,
      starterHash: r.starterHash,
      isMock: r.usedMockProvider,
      noBrowserAgent: ev?.browserAgentSkipped ?? false,
    };
  }

  function artifactRef(a: ArtifactRow): ArtifactRef {
    return { kind: a.kind, path: displayPath(a.path), url: artifactUrl(a.path), sha256: a.sha256, bytes: a.bytes };
  }

  function configDir(configId: string | null): string | null {
    if (!configId) return null;
    const row = db.getConfig(configId);
    const candidates = [row?.path, path.join('configs', configId)].filter((p): p is string => !!p);
    for (const c of candidates) if (fs.existsSync(abs(c))) return abs(c);
    return null;
  }

  function readTrace(file: string | null): RunDetail['trace'] {
    if (!file || !fs.existsSync(file)) return { url: null, entries: [], truncated: false, totalLines: 0 };
    const url = artifactUrl(file);
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(size, TRACE_MAX_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    let lines = buf.toString('utf8').split('\n');
    if (size > TRACE_MAX_BYTES) lines.pop(); // partial last line
    lines = lines.filter((l) => l.trim());
    const totalLines = size > TRACE_MAX_BYTES ? lines.length + 1 : lines.length;
    const entries: TraceEntry[] = lines.slice(0, TRACE_MAX_LINES).map((l) => {
      try {
        const v = JSON.parse(l);
        return v && typeof v === 'object' && !Array.isArray(v) ? v : { type: 'value', value: v };
      } catch {
        return { type: 'unparsed', text: l };
      }
    });
    return { url, entries, truncated: totalLines > entries.length || size > TRACE_MAX_BYTES, totalLines };
  }

  function listPngs(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && /\.(png|jpe?g|webp)$/i.test(d.name))
        .map((d) => path.join(dir, d.name))
        .sort();
    } catch {
      return [];
    }
  }

  return {
    warnings,
    close: () => db.close(),

    overview(): Overview {
      const o = db.getOverview();
      const list = db.listExperimentsWithAggregates();
      const byId = new Map(list.map((e) => [e.id, e]));
      const best: ConfigSummary | null = o.best
        ? (() => {
            const e = byId.get(o.best.experimentId);
            const s = o.best.summary;
            return {
              configId: o.best.configId,
              experimentId: o.best.experimentId,
              runs: s.runs ?? e?.runsTotal ?? 0,
              passes: s.passes ?? 0,
              passRate: o.best.passRate,
              medianTokens: o.best.medianTokens,
              medianVisualScore: s.medianVisualScore ?? e?.medianVisualScore ?? null,
              verified: true,
              isMock: false,
            };
          })()
        : null;
      const mb = mockBestOf(list);
      const mockBest = mb ? configSummary(mb, true) : null;
      const baseExp = o.baseline ? byId.get(o.baseline.experimentId) : undefined;
      const baseline: ConfigSummary | null =
        o.baseline && baseExp
          ? { ...configSummary(baseExp, o.baseline.meetsQuality), configId: o.baseline.configId, medianTokens: o.baseline.medianTokens ?? baseExp.medianTokens }
          : null;
      let improvementPct = o.improvementPct;
      let improvementIsMock = false;
      if (improvementPct === null && !best && mockBest?.medianTokens && baseline?.medianTokens) {
        improvementPct = ((baseline.medianTokens - mockBest.medianTokens) / baseline.medianTokens) * 100;
        improvementIsMock = true;
      }
      const runs = db.listRuns();
      const evaluated = runs.filter((r) => r.status !== 'running' && r.passed !== null).length;
      const running = list.filter((e) => ['pending', 'running', 'verifying'].includes(e.status)).length;
      const roles = db.costAndTokensByRole();
      const rc = (k: 'coding' | 'evaluator' | 'research') => ({ tokens: roles[k].totalTokens, costUsd: roles[k].costUsd, calls: roles[k].modelCalls });
      return {
        generatedAt: new Date().toISOString(),
        dbPath: displayPath(opts.dbPath),
        anyMock: o.anyMock,
        allMock: list.length > 0 && list.every((e) => e.anyMock),
        anyNoBrowserAgent: o.anyBrowserAgentSkipped,
        best,
        mockBest,
        baseline,
        improvementPct,
        improvementIsMock,
        experiments: { total: o.experimentsTotal, completed: o.experimentsFinished, running, byOutcome: o.experimentsByOutcome },
        runs: { total: o.runsTotal, evaluated, passed: o.runsPassed },
        cost: { coding: rc('coding'), evaluator: rc('evaluator'), research: rc('research'), totalUsd: o.costByRole.total },
      };
    },

    experiments(): ExperimentRow[] {
      const list = db.listExperimentsWithAggregates();
      const ctx = rowCtx(list);
      return list.map((e) => toRow(e, ctx));
    },

    experiment(id: string): ExperimentDetail | null {
      const d = db.getExperimentDetail(id);
      if (!d) return null;
      const e = d.experiment;
      const row = toRow(e, rowCtx(db.listExperimentsWithAggregates()));

      // Config diff: real file diff between parent and candidate config dirs; fall back to `changes` if it is a diff.
      let configDiff: string | null = null;
      const aDir = configDir(e.parentConfigId);
      const bDir = configDir(e.candidateConfigId);
      if (aDir && bDir && aDir !== bDir) configDiff = diffDirs(aDir, bDir, e.parentConfigId!, e.candidateConfigId!);
      if (!configDiff && /^(\+\+\+|---|@@|[+-])/m.test(e.changes)) configDiff = e.changes;

      return {
        experiment: { ...row, changes: e.changes, changeSummary: e.changeSummary, error: e.error, notes: e.notes, kind: e.kind },
        configDiff,
        runs: d.runs.map((r) => runRow(r, r.evaluations)),
        artifacts: d.artifacts.filter((a) => !a.runId).map(artifactRef),
      };
    },

    run(id: string): RunDetail | null {
      const r = db.getRun(id);
      if (!r) return null;
      const evals = db.listEvaluations(id);
      const artifacts = db.listArtifacts({ runId: id });
      const runDir = path.join(resultsDir, 'runs', id);

      const evaluations: EvaluationView[] = evals.map((ev) => ({
        suite: ev.suite,
        passed: ev.passed,
        appStarted: ev.appStarted,
        visualScore: ev.visualScore,
        visualThreshold: ev.visualThreshold,
        evaluatorFailure: ev.evaluatorFailure,
        failureSummary: ev.failureSummary,
        startedAt: ev.startedAt,
        finishedAt: ev.finishedAt,
        checks: (ev.checks ?? []).map((c) => ({
          id: c.id,
          category: c.category,
          mandatory: c.mandatory,
          outcome: c.outcome,
          message: c.message ?? null,
          evidence: (c.evidence ?? []).map(displayPath),
          attempts: c.attempts ?? 1,
        })),
        reportUrl: artifactUrl(ev.reportPath),
        browserAgentSkipped: ev.browserAgentSkipped,
      }));

      // Token breakdown by role. coding = runs row; evaluator = evaluations rows; research = usage_records for this run.
      const tokens: TokenBreakdownRow[] = [
        {
          role: 'coding',
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          reasoningTokens: r.reasoningTokens,
          cacheReadTokens: r.cacheReadTokens,
          cacheWriteTokens: r.cacheWriteTokens,
          totalTokens: r.totalTokens,
          costUsd: r.costUsd,
          calls: r.modelCalls,
          anyEstimated: r.usageEstimated,
        },
      ];
      if (evals.length) {
        const s = (f: (e: EvaluationRow) => number) => evals.reduce((a, e) => a + (f(e) || 0), 0);
        tokens.push({
          role: 'evaluator',
          inputTokens: s((e) => e.evaluatorInputTokens),
          outputTokens: s((e) => e.evaluatorOutputTokens),
          reasoningTokens: s((e) => e.evaluatorReasoningTokens),
          cacheReadTokens: s((e) => e.evaluatorCacheReadTokens),
          cacheWriteTokens: s((e) => e.evaluatorCacheWriteTokens),
          totalTokens: s((e) => e.evaluatorTotalTokens),
          costUsd: s((e) => e.evaluatorCostUsd),
          calls: s((e) => e.evaluatorModelCalls),
          anyEstimated: evals.some((e) => e.evaluatorUsageEstimated),
        });
      }
      const research = db.usageRecordTotalsByRole({ runId: id }).research;
      if (research.modelCalls > 0) {
        tokens.push({
          role: 'research',
          inputTokens: research.inputTokens,
          outputTokens: research.outputTokens,
          reasoningTokens: research.reasoningTokens,
          cacheReadTokens: research.cacheReadTokens,
          cacheWriteTokens: research.cacheWriteTokens,
          totalTokens: research.totalTokens,
          costUsd: research.costUsd,
          calls: research.modelCalls,
          anyEstimated: research.anyEstimated,
        });
      }

      // Screenshots: artifact rows + check evidence + eval/<suite>/screenshots dirs on disk.
      const shotFiles = new Set<string>();
      for (const a of artifacts) if (/\.(png|jpe?g|webp)$/i.test(a.path)) shotFiles.add(abs(a.path));
      for (const ev of evals) {
        for (const c of ev.checks ?? []) for (const p of c.evidence ?? []) if (/\.(png|jpe?g|webp)$/i.test(p)) shotFiles.add(abs(p));
        const evalDirs = [ev.reportPath ? path.dirname(abs(ev.reportPath)) : null, path.join(runDir, 'eval', ev.suite)].filter((d): d is string => !!d);
        for (const d of evalDirs) for (const f of listPngs(path.join(d, 'screenshots'))) shotFiles.add(f);
      }
      const screenshots = [...shotFiles]
        .filter((f) => fs.existsSync(f))
        .map((f) => ({ url: artifactUrl(f), name: path.relative(runDir, f).startsWith('..') ? path.basename(f) : path.relative(runDir, f) }))
        .filter((s): s is { url: string; name: string } => !!s.url)
        .sort((a, b) => a.name.localeCompare(b.name));

      const traceArtifact = artifacts.find((a) => /(^|\/)trace\.jsonl$/.test(a.path) || a.kind === 'trace' || a.kind === 'agent-trace');
      const traceFile = traceArtifact ? abs(traceArtifact.path) : path.join(runDir, 'trace.jsonl');

      return {
        run: runRow(r, evals),
        evaluations,
        tokens,
        screenshots,
        artifacts: artifacts.map(artifactRef),
        trace: readTrace(traceFile),
        profileUrl: fs.existsSync(path.join(runDir, 'profile.json')) ? artifactUrl(path.join(runDir, 'profile.json')) : null,
      };
    },

    charts(): Charts {
      const list = db.listExperimentsWithAggregates();
      const history = db.getBestHistory();
      const useMock = history.length === 0 && list.some((e) => e.anyMock);
      let runningBest: number | null = null;
      const bestOverTime = list.map((e, index) => {
        if (useMock) {
          const t = tokensOf(e);
          if (isVerified(e) && t !== null && (runningBest === null || t < runningBest)) runningBest = t;
        } else {
          const promos = history.filter((h) => h.experimentSeq !== null && h.experimentSeq <= e.seq);
          runningBest = promos.length ? promos[promos.length - 1].medianTokens : null;
        }
        return {
          index,
          experimentId: e.id,
          createdAt: e.createdAt,
          medianTokens: tokensOf(e),
          passed: isVerified(e),
          bestTokens: runningBest,
          isMock: e.anyMock,
        };
      });

      const scatter = db.getTokensVsQuality().map((p) => ({
        runId: p.runId,
        experimentId: p.experimentId,
        configId: p.configId,
        tokens: p.totalTokens,
        visualScore: p.visualScore,
        passed: p.passed,
        isMock: p.usedMockProvider,
      }));

      const passRateByConfig = db
        .getPassRateByConfig()
        .map((c) => ({ configId: c.configId, runs: c.runs, passes: c.passes, passRate: c.passRate, isMock: c.anyMock }))
        .sort((a, b) => a.configId.localeCompare(b.configId, 'en', { numeric: true }));

      let cost = db.getResearchCostOverTime().map((p) => ({
        timestamp: p.timestamp,
        coding: p.cumulativeByRole.coding,
        evaluator: p.cumulativeByRole.evaluator,
        research: p.cumulativeByRole.research,
        total: p.cumulativeByRole.total,
      }));
      if (cost.length > 600) {
        // Downsample but keep the last point (cumulative, so dropping points loses nothing important).
        const step = Math.ceil(cost.length / 600);
        cost = cost.filter((_, i) => i % step === 0 || i === cost.length - 1);
      }
      return { bestOverTime, scatter, passRateByConfig, costOverTime: cost };
    },
  };
}

