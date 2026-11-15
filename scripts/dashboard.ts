/**
 * Read-only results dashboard.
 *
 *   npm run dashboard [-- --port 4173] [--host 127.0.0.1] [--db results/benchmark.db] [--no-build]
 *
 * Opens the SQLite results DB read-only and serves:
 *   GET /api/overview  /api/experiments  /api/experiments/:id  /api/runs/:id  /api/charts
 *   GET /artifacts/<path>   files under results/ (path-traversal safe)
 *   GET /                   the React UI from dashboard/dist (built automatically if missing)
 *
 * Development data: `npx tsx dashboard/dev-seed.ts` writes fake data to results/dev-dashboard.db,
 * then `npm run dashboard -- --db results/dev-dashboard.db`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDashboardData } from '../dashboard/server/data.js';
import { createDashboardServer } from '../dashboard/server/http.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Args {
  port: number;
  host: string;
  db: string;
  build: boolean;
}

function usage(): string {
  return `Usage: npm run dashboard -- [options]

Options:
  --port <n>     Port to listen on (default 4173)
  --host <addr>  Interface to bind (default 127.0.0.1)
  --db <path>    SQLite DB to read (default results/benchmark.db, or $FRUGAL_DB_PATH)
  --no-build     Don't build dashboard/dist automatically if it is missing
  -h, --help     Show this help`;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    port: 4173,
    host: '127.0.0.1',
    db: process.env.FRUGAL_DB_PATH ?? path.join('results', 'benchmark.db'),
    build: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    if (a === '-h' || a === '--help') {
      console.log(usage());
      process.exit(0);
    } else if (a === '--port' || a.startsWith('--port=')) args.port = Number(val());
    else if (a === '--host' || a.startsWith('--host=')) args.host = val();
    else if (a === '--db' || a.startsWith('--db=')) args.db = val();
    else if (a === '--no-build') args.build = false;
    else throw new Error(`Unknown argument: ${a}\n\n${usage()}`);
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error(`Invalid --port: ${args.port}`);
  return args;
}

function ensureBuilt(distDir: string, allowBuild: boolean): void {
  if (fs.existsSync(path.join(distDir, 'index.html'))) return;
  const dashDir = path.join(repoRoot, 'dashboard');
  const instructions = `  npm --prefix dashboard install && npm --prefix dashboard run build`;
  if (!allowBuild) {
    console.warn(`[dashboard] UI not built (dashboard/dist missing). The API still works. To build the UI:\n${instructions}`);
    return;
  }
  console.log('[dashboard] dashboard/dist is missing; building the UI (one-time)...');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const steps: string[][] = [];
  if (!fs.existsSync(path.join(dashDir, 'node_modules'))) steps.push(['--prefix', dashDir, 'install', '--no-audit', '--no-fund']);
  steps.push(['--prefix', dashDir, 'run', 'build']);
  for (const step of steps) {
    const res = spawnSync(npm, step, { stdio: 'inherit', cwd: repoRoot });
    if (res.status !== 0) {
      console.warn(`[dashboard] UI build failed (npm ${step.join(' ')}). The API still works. Build manually with:\n${instructions}`);
      return;
    }
  }
}

function main(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  const dbPath = path.resolve(repoRoot, args.db);
  const resultsDir = path.join(repoRoot, 'results');
  const distDir = path.join(repoRoot, 'dashboard', 'dist');
  fs.mkdirSync(resultsDir, { recursive: true });

  ensureBuilt(distDir, args.build);

  const data = createDashboardData({ dbPath, repoRoot, resultsDir });
  for (const w of data.warnings) console.warn(`[dashboard] ${w}`);
  const server = createDashboardServer({ data, resultsDir, distDir });

  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(err.code === 'EADDRINUSE' ? `[dashboard] Port ${args.port} is in use; pass --port <n>.` : `[dashboard] ${err.message}`);
    process.exit(1);
  });
  server.listen(args.port, args.host, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : args.port;
    console.log(`[dashboard] Reading ${path.relative(repoRoot, dbPath) || dbPath} (read-only)`);
    console.log(`[dashboard] Open http://${args.host}:${port}/`);
  });

  const shutdown = () => {
    server.close();
    data.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
