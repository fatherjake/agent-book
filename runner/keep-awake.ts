/**
 * Keep the host awake while a long benchmark/research process runs.
 *
 * Why: on macOS, idle sleep freezes the Docker Desktop VM mid-evaluation. After wake the VM clock
 * lags the host for a while, so time-sensitive checks (e.g. "createdAt is close to now") and
 * readiness timeouts fail spuriously, and the sleep counts against wall-clock budgets.
 * On macOS this spawns `caffeinate -i -s -w <pid>` (prevents idle sleep, and system sleep on AC power, until this process exits).
 * It does NOT prevent sleep when a laptop lid is closed. No-op elsewhere or with FRUGAL_NO_CAFFEINATE=1.
 */
import { spawn } from 'node:child_process';

export function keepAwake(): boolean {
  if (process.platform !== 'darwin' || process.env.FRUGAL_NO_CAFFEINATE === '1') return false;
  try {
    const child = spawn('caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
