import { describe, expect, it } from 'vitest';
import { ArgError, formatHelp, parseArgs, type CommandSpec } from '../../researcher/cli-args.js';
import { BENCHMARK_CLI } from '../../scripts/run-benchmark.js';
import { RESEARCH_CLI } from '../../scripts/start-research.js';
import { RESULTS_CLI } from '../../scripts/results.js';
import { REPORT_CLI } from '../../scripts/generate-report.js';

const spec: CommandSpec = {
  command: 'test',
  summary: 's',
  flags: [
    { name: 'config', type: 'string', description: 'cfg', default: 'baseline' },
    { name: 'runs', type: 'number', description: 'n', default: 1, integer: true, min: 1 },
    { name: 'suite', type: 'string', description: 's', choices: ['dev', 'holdout'] },
    { name: 'dry-run', type: 'boolean', description: 'd' },
  ],
};

describe('cli arg parser', () => {
  it('parses flags, defaults, = syntax and booleans', () => {
    expect(parseArgs([], spec)).toEqual({ config: 'baseline', runs: 1 });
    expect(parseArgs(['--config', 'experiments/001', '--runs=3', '--dry-run', '--suite', 'holdout'], spec)).toEqual({
      config: 'experiments/001',
      runs: 3,
      'dry-run': true,
      suite: 'holdout',
    });
    expect(parseArgs(['--', '--dry-run=false'], spec)['dry-run']).toBe(false);
    expect(parseArgs(['-h'], spec).help).toBe(true);
  });
  it('rejects bad input', () => {
    expect(() => parseArgs(['--nope'], spec)).toThrow(ArgError);
    expect(() => parseArgs(['--runs', 'x'], spec)).toThrow(/number/);
    expect(() => parseArgs(['--runs', '1.5'], spec)).toThrow(/integer/);
    expect(() => parseArgs(['--runs', '0'], spec)).toThrow(/>= 1/);
    expect(() => parseArgs(['--suite', 'prod'], spec)).toThrow(/one of/);
    expect(() => parseArgs(['--config'], spec)).toThrow(/requires a value/);
    expect(() => parseArgs(['positional'], spec)).toThrow(/unexpected/);
  });
  it('documents every flag in --help', () => {
    for (const s of [BENCHMARK_CLI, RESEARCH_CLI, RESULTS_CLI, REPORT_CLI]) {
      const h = formatHelp(s);
      for (const f of s.flags) expect(h).toContain(`--${f.name}`);
      expect(h).toContain('--help');
    }
  });
  it('parses the real command specs', () => {
    expect(parseArgs(['--config', 'experiments/001', '--runs', '3', '--provider', 'mock', '--dry-run'], BENCHMARK_CLI)).toMatchObject({ config: 'experiments/001', runs: 3, provider: 'mock', 'dry-run': true });
    expect(parseArgs(['--max-experiments', '20', '--max-cost', '12.5', '--resume'], RESEARCH_CLI)).toMatchObject({ 'max-experiments': 20, 'max-cost': 12.5, resume: true });
    expect(() => parseArgs(['--suite', 'prod'], BENCHMARK_CLI)).toThrow();
    expect(parseArgs(['--experiment', 'exp-0003', '--json'], RESULTS_CLI)).toMatchObject({ experiment: 'exp-0003', json: true });
  });
});
