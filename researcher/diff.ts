/** Minimal line diff (LCS) producing unified-style hunks. No dependencies. */

type Op = { t: ' ' | '-' | '+'; line: string };

function splitLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lcsOps(a: string[], b: string[]): Op[] {
  // Trim common prefix/suffix to keep the DP small.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const ops: Op[] = a.slice(0, pre).map((line) => ({ t: ' ', line }));
  const n = A.length;
  const m = B.length;
  if (n * m > 25_000_000) {
    // Too large for DP: fall back to full replacement of the middle part.
    ops.push(...A.map((line) => ({ t: '-' as const, line })), ...B.map((line) => ({ t: '+' as const, line })));
  } else {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) {
        ops.push({ t: ' ', line: A[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) ops.push({ t: '-', line: A[i++] });
      else ops.push({ t: '+', line: B[j++] });
    }
    while (i < n) ops.push({ t: '-', line: A[i++] });
    while (j < m) ops.push({ t: '+', line: B[j++] });
  }
  ops.push(...a.slice(a.length - suf).map((line) => ({ t: ' ' as const, line })));
  return ops;
}

/** Unified-style diff of one file. Returns '' when identical. */
export function diffLines(before: string | null, after: string | null, path: string, context = 2): string {
  if (before === after) return '';
  const a = splitLines(before ?? '');
  const b = splitLines(after ?? '');
  const ops = lcsOps(a, b);
  const header = `--- ${before === null ? '/dev/null' : 'a/' + path}\n+++ ${after === null ? '/dev/null' : 'b/' + path}\n`;
  const out: string[] = [];
  // Build hunks around changed ops.
  const changed = ops.map((o) => o.t !== ' ');
  let k = 0;
  while (k < ops.length) {
    if (!changed[k]) {
      k++;
      continue;
    }
    let start = Math.max(0, k - context);
    let end = k;
    // extend while changes are within 2*context of each other
    while (end < ops.length) {
      if (changed[end]) {
        end++;
        continue;
      }
      let next = end;
      while (next < ops.length && !changed[next] && next - end < 2 * context + 1) next++;
      if (next < ops.length && changed[next] && next - end <= 2 * context) end = next;
      else break;
    }
    const stop = Math.min(ops.length, end + context);
    // line numbers
    let aLine = 1;
    let bLine = 1;
    for (let q = 0; q < start; q++) {
      if (ops[q].t !== '+') aLine++;
      if (ops[q].t !== '-') bLine++;
    }
    const slice = ops.slice(start, stop);
    const aCount = slice.filter((o) => o.t !== '+').length;
    const bCount = slice.filter((o) => o.t !== '-').length;
    out.push(`@@ -${aLine},${aCount} +${bLine},${bCount} @@`);
    for (const o of slice) out.push(`${o.t}${o.line}`);
    k = stop;
    start = stop;
  }
  return header + out.join('\n') + '\n';
}

/** Diff a set of files (path → content|null). */
export function diffFileSets(before: Record<string, string>, after: Record<string, string>, context = 2): string {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return paths
    .map((p) => diffLines(p in before ? before[p] : null, p in after ? after[p] : null, p, context))
    .filter(Boolean)
    .join('');
}
