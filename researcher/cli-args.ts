/** Tiny hand-rolled CLI argument parser shared by the scripts/*.ts commands. */

export type FlagType = 'string' | 'number' | 'boolean';

export interface FlagSpec {
  name: string; // without leading dashes, e.g. 'max-experiments'
  type: FlagType;
  description: string;
  default?: string | number | boolean;
  choices?: readonly string[];
  /** For numbers: must be an integer. */
  integer?: boolean;
  min?: number;
}

export interface CommandSpec {
  command: string;
  summary: string;
  flags: FlagSpec[];
  examples?: string[];
}

export type ParsedArgs = Record<string, string | number | boolean | undefined> & { help?: boolean };

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgError';
  }
}

export function parseArgs(argv: string[], spec: CommandSpec): ParsedArgs {
  const byName = new Map(spec.flags.map((f) => [f.name, f]));
  const out: ParsedArgs = {};
  for (const f of spec.flags) if (f.default !== undefined) out[f.name] = f.default;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--help' || tok === '-h') {
      out.help = true;
      continue;
    }
    if (tok === '--') continue; // npm passes this through sometimes
    if (!tok.startsWith('--')) throw new ArgError(`unexpected argument "${tok}"`);
    let name = tok.slice(2);
    let value: string | undefined;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    const f = byName.get(name);
    if (!f) throw new ArgError(`unknown flag --${name} (see --help)`);
    if (f.type === 'boolean') {
      if (value === undefined) out[name] = true;
      else if (value === 'true' || value === '1') out[name] = true;
      else if (value === 'false' || value === '0') out[name] = false;
      else throw new ArgError(`--${name} expects true/false`);
      continue;
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined || (value.startsWith('--') && f.type !== 'number')) throw new ArgError(`--${name} requires a value`);
    }
    if (f.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new ArgError(`--${name} expects a number, got "${value}"`);
      if (f.integer && !Number.isInteger(n)) throw new ArgError(`--${name} expects an integer, got "${value}"`);
      if (f.min !== undefined && n < f.min) throw new ArgError(`--${name} must be >= ${f.min}`);
      out[name] = n;
    } else {
      if (f.choices && !f.choices.includes(value)) throw new ArgError(`--${name} must be one of: ${f.choices.join(', ')}`);
      out[name] = value;
    }
  }
  return out;
}

export function formatHelp(spec: CommandSpec): string {
  const rows = spec.flags.map((f) => {
    const arg = f.type === 'boolean' ? '' : f.choices ? ` <${f.choices.join('|')}>` : f.type === 'number' ? ' <n>' : ' <value>';
    const def = f.default !== undefined ? ` (default: ${f.default})` : '';
    return [`  --${f.name}${arg}`, `${f.description}${def}`];
  });
  rows.push(['  --help, -h', 'Show this help']);
  const w = Math.max(...rows.map((r) => r[0].length)) + 2;
  const lines = [`Usage: ${spec.command} [flags]`, '', spec.summary, '', 'Flags:', ...rows.map(([a, d]) => a.padEnd(w) + d)];
  if (spec.examples?.length) lines.push('', 'Examples:', ...spec.examples.map((e) => `  ${e}`));
  return lines.join('\n');
}

/** Parse or print help/errors and exit. */
export function parseOrExit(argv: string[], spec: CommandSpec): ParsedArgs {
  try {
    const a = parseArgs(argv, spec);
    if (a.help) {
      console.log(formatHelp(spec));
      process.exit(0);
    }
    return a;
  } catch (e) {
    if (e instanceof ArgError) {
      console.error(`error: ${e.message}\n`);
      console.error(formatHelp(spec));
      process.exit(2);
    }
    throw e;
  }
}
