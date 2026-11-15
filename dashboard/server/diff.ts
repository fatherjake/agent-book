/** Tiny unified line diff (LCS-based) for config directories. Config files are small. */
import fs from 'node:fs';
import path from 'node:path';

const MAX_LINES = 4000;

export function unifiedDiff(aName: string, bName: string, a: string, b: string, context = 3): string {
  const A = a.split('\n');
  const B = b.split('\n');
  if (A.length > MAX_LINES || B.length > MAX_LINES) return `--- ${aName}\n+++ ${bName}\n@@ file too large to diff @@`;
  const n = A.length;
  const m = B.length;
  // LCS table (lengths of suffixes)
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  type Op = { t: ' ' | '-' | '+'; s: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) ops.push({ t: ' ', s: A[i], ai: i++, bi: j++ });
    else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) ops.push({ t: '-', s: A[i], ai: i++, bi: j });
    else ops.push({ t: '+', s: B[j], ai: i, bi: j++ });
  }
  if (!ops.some((o) => o.t !== ' ')) return '';
  const out = [`--- ${aName}`, `+++ ${bName}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === ' ') {
      k++;
      continue;
    }
    const start = Math.max(0, k - context);
    let end = k;
    // extend hunk while changes are within 2*context of each other
    while (end < ops.length) {
      if (ops[end].t !== ' ') {
        end++;
        continue;
      }
      let run = 0;
      while (end + run < ops.length && ops[end + run].t === ' ') run++;
      if (end + run >= ops.length || run > context * 2) {
        end = Math.min(ops.length, end + context);
        break;
      }
      end += run;
    }
    const hunk = ops.slice(start, end);
    const aStart = hunk[0].ai + 1;
    const bStart = hunk[0].bi + 1;
    const aLen = hunk.filter((o) => o.t !== '+').length;
    const bLen = hunk.filter((o) => o.t !== '-').length;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const o of hunk) out.push(o.t + o.s);
    k = end;
  }
  return out.join('\n');
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else if (e.isFile()) out.push(path.relative(base, p));
  }
  return out.sort();
}

function readText(p: string): string {
  try {
    const buf = fs.readFileSync(p);
    if (buf.length > 512 * 1024) return '(file larger than 512 KB, not shown)';
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

/** Diff every file of two config directories. Returns null if either dir is missing. */
export function diffDirs(aDir: string, bDir: string, aLabel: string, bLabel: string): string | null {
  if (!fs.existsSync(aDir) || !fs.existsSync(bDir)) return null;
  const files = [...new Set([...listFiles(aDir), ...listFiles(bDir)])].sort();
  const parts: string[] = [];
  for (const f of files) {
    const ap = path.join(aDir, f);
    const bp = path.join(bDir, f);
    const aExists = fs.existsSync(ap);
    const bExists = fs.existsSync(bp);
    const d = unifiedDiff(aExists ? `${aLabel}/${f}` : '/dev/null', bExists ? `${bLabel}/${f}` : '/dev/null', aExists ? readText(ap) : '', bExists ? readText(bp) : '');
    if (d) parts.push(d);
  }
  return parts.length ? parts.join('\n') : '(no file differences)';
}
