/**
 * Build (or reuse) the benchmark image frugal-bench:<starterHash>.
 * Usage: npm run build:image [-- --force]
 */
import { ensureImage } from '../benchmark/docker/image.js';

const force = process.argv.includes('--force');
const started = Date.now();
try {
  const res = await ensureImage({ force, onLog: (c) => process.stderr.write(c) });
  console.log(JSON.stringify({ ...res, seconds: Math.round((Date.now() - started) / 1000) }, null, 2));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
