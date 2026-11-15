/**
 * Hand-rolled SVG charts. No chart library: each chart maps data to a fixed
 * viewBox and scales to its container width via CSS.
 */
import { useState, type ReactNode } from 'react';
import { fmtTokens } from './format';

const W = 640;
const H = 280;
const M = { top: 16, right: 16, bottom: 40, left: 60 };
const IW = W - M.left - M.right;
const IH = H - M.top - M.bottom;

function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    max = min + 1;
    min = Math.max(0, min - 1);
  }
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.5; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

function linear(d0: number, d1: number, r0: number, r1: number) {
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

interface Tip {
  x: number;
  y: number;
  text: ReactNode;
}

function Frame({
  yTicks,
  y,
  yFmt,
  xLabel,
  yLabel,
  children,
  tip,
  ariaLabel,
}: {
  yTicks: number[];
  y: (v: number) => number;
  yFmt: (v: number) => string;
  xLabel: string;
  yLabel: string;
  children: ReactNode;
  tip: Tip | null;
  ariaLabel: string;
}) {
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}>
        <g transform={`translate(${M.left},${M.top})`}>
          {yTicks.map((t) => (
            <g key={t}>
              <line className="grid" x1={0} x2={IW} y1={y(t)} y2={y(t)} />
              <text className="tick" x={-8} y={y(t)} dy="0.32em" textAnchor="end">
                {yFmt(t)}
              </text>
            </g>
          ))}
          <line className="axis" x1={0} x2={IW} y1={IH} y2={IH} />
          {children}
          <text className="axis-label" x={IW / 2} y={IH + 34} textAnchor="middle">
            {xLabel}
          </text>
          <text className="axis-label" transform={`translate(${-48},${IH / 2}) rotate(-90)`} textAnchor="middle">
            {yLabel}
          </text>
        </g>
      </svg>
      {tip && (
        <div className="chart-tip" style={{ left: `${(tip.x / W) * 100}%`, top: `${(tip.y / H) * 100}%` }}>
          {tip.text}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export interface StepPoint {
  label: string;
  value: number | null; // running best (null until first verified)
  raw: number | null; // this experiment's own median tokens
  passed: boolean | null;
}

/** Step line of the running best, plus each experiment's own value as a dot. */
export function StepLineChart({ points }: { points: StepPoint[] }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const vals = points.flatMap((p) => [p.value, p.raw]).filter((v): v is number => v !== null);
  if (!points.length || !vals.length) return <div className="empty">No data yet.</div>;
  const yTicks = niceTicks(0, Math.max(...vals));
  const y = linear(0, yTicks[yTicks.length - 1], IH, 0);
  const x = linear(0, Math.max(points.length - 1, 1), 0, IW);
  let d = '';
  let prev: number | null = null;
  points.forEach((p, i) => {
    if (p.value === null) return;
    if (prev === null) d += `M${x(i)},${y(p.value)}`;
    else d += `H${x(i)}V${y(p.value)}`;
    prev = p.value;
  });
  if (prev !== null) d += `H${x(points.length - 1)}`;
  const labelEvery = Math.ceil(points.length / 10);
  return (
    <Frame yTicks={yTicks} y={y} yFmt={fmtTokens} xLabel="Experiment" yLabel="Median coding tokens" tip={tip} ariaLabel="Best verified tokens over experiments">
      {points.map((p, i) =>
        i % labelEvery === 0 ? (
          <text key={'l' + i} className="tick" x={x(i)} y={IH + 16} textAnchor="middle">
            {p.label}
          </text>
        ) : null,
      )}
      <path className="series-1 line" d={d} />
      {points.map((p, i) =>
        p.raw === null ? null : (
          <circle
            key={i}
            cx={x(i)}
            cy={y(p.raw)}
            r={4}
            className={p.passed ? 'dot-pass' : 'dot-fail'}
            onMouseEnter={() =>
              setTip({
                x: M.left + x(i),
                y: M.top + y(p.raw!),
                text: (
                  <>
                    <b>{p.label}</b>
                    <br />
                    median {fmtTokens(p.raw)} · {p.passed ? 'verified' : 'not verified'}
                    <br />
                    best so far {fmtTokens(p.value)}
                  </>
                ),
              })
            }
            onMouseLeave={() => setTip(null)}
          />
        ),
      )}
    </Frame>
  );
}

// ---------------------------------------------------------------------------

export interface ScatterPoint {
  id: string;
  x: number; // tokens
  y: number; // quality (visual score 0-100)
  passed: boolean | null;
}

export function ScatterChart({ points, yLabel }: { points: ScatterPoint[]; yLabel: string }) {
  const [tip, setTip] = useState<Tip | null>(null);
  if (!points.length) return <div className="empty">No data yet.</div>;
  const xTicks = niceTicks(0, Math.max(...points.map((p) => p.x)));
  const x = linear(0, xTicks[xTicks.length - 1], 0, IW);
  const yTicks = [0, 20, 40, 60, 80, 100];
  const y = linear(0, 100, IH, 0);
  return (
    <Frame yTicks={yTicks} y={y} yFmt={String} xLabel="Coding tokens (run total)" yLabel={yLabel} tip={tip} ariaLabel="Tokens versus quality">
      {xTicks.map((t) => (
        <text key={t} className="tick" x={x(t)} y={IH + 16} textAnchor="middle">
          {fmtTokens(t)}
        </text>
      ))}
      <line className="threshold" x1={0} x2={IW} y1={y(95)} y2={y(95)} />
      <text className="tick" x={4} y={y(95) + 12} textAnchor="start">
        threshold 95
      </text>
      {points.map((p) => (
        <circle
          key={p.id}
          cx={x(p.x)}
          cy={y(p.y)}
          r={4.5}
          className={p.passed === null ? 'dot-neutral' : p.passed ? 'dot-pass' : 'dot-fail'}
          onMouseEnter={() =>
            setTip({
              x: M.left + x(p.x),
              y: M.top + y(p.y),
              text: (
                <>
                  <b>{p.id}</b>
                  <br />
                  {fmtTokens(p.x)} tokens · quality {p.y.toFixed(1)} · {p.passed === null ? 'n/a' : p.passed ? 'pass' : 'fail'}
                </>
              ),
            })
          }
          onMouseLeave={() => setTip(null)}
        />
      ))}
    </Frame>
  );
}

// ---------------------------------------------------------------------------

export interface Bar {
  label: string;
  value: number; // 0..1
  note: string;
  mock?: boolean;
}

/** Horizontal bars, one row per configuration (labels can be long). */
export function BarChart({ bars }: { bars: Bar[] }) {
  if (!bars.length) return <div className="empty">No data yet.</div>;
  const rowH = 26;
  const labelW = 170;
  const noteW = 90;
  const w = W;
  const h = bars.length * rowH + 24;
  const bw = w - labelW - noteW;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Pass rate by configuration">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line className="grid" x1={labelW + t * bw} x2={labelW + t * bw} y1={0} y2={h - 20} />
            <text className="tick" x={labelW + t * bw} y={h - 6} textAnchor="middle">
              {t * 100}%
            </text>
          </g>
        ))}
        {bars.map((b, i) => (
          <g key={b.label} transform={`translate(0,${i * rowH})`}>
            <text className="tick" x={labelW - 8} y={rowH / 2} dy="0.32em" textAnchor="end">
              {b.label.length > 24 ? b.label.slice(0, 23) + '…' : b.label}
              {b.mock ? ' [M]' : ''}
            </text>
            <rect x={labelW} y={5} width={Math.max(b.value * bw, 1.5)} height={rowH - 10} rx={3} className={b.value >= 1 ? 'bar-pass' : 'bar'}>
              <title>
                {b.label}: {b.note}
              </title>
            </rect>
            <text className="tick" x={labelW + bw + 8} y={rowH / 2} dy="0.32em">
              {b.note}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------

export interface CostPoint {
  t: number; // ms epoch
  total: number;
  coding: number;
  evaluator: number;
  research: number;
}

export function CumulativeLineChart({ points, fmt }: { points: CostPoint[]; fmt: (n: number) => string }) {
  const [tip, setTip] = useState<Tip | null>(null);
  if (points.length < 1) return <div className="empty">No data yet.</div>;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const x = linear(t0, t1 === t0 ? t0 + 1 : t1, 0, IW);
  const yTicks = niceTicks(0, Math.max(...points.map((p) => p.total)));
  const y = linear(0, yTicks[yTicks.length - 1], IH, 0);
  const series = [
    { key: 'total', cls: 'series-1' },
    { key: 'coding', cls: 'series-2' },
    { key: 'evaluator', cls: 'series-3' },
    { key: 'research', cls: 'series-4' },
  ] as const;
  const fmtT = (t: number) => new Date(t).toISOString().slice(5, 16).replace('T', ' ');
  return (
    <>
      <Frame yTicks={yTicks} y={y} yFmt={fmt} xLabel="Time (UTC)" yLabel="Cumulative API-equiv. cost" tip={tip} ariaLabel="API-equivalent cost over time">
        {[t0, (t0 + t1) / 2, t1].map((t, i) => (
          <text key={i} className="tick" x={x(t)} y={IH + 16} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>
            {fmtT(t)}
          </text>
        ))}
        {series.map((s) => (
          <path key={s.key} className={s.cls + ' line'} d={points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t)},${y(p[s.key])}`).join('')} />
        ))}
        {points.map((p, i) => (
          <rect
            key={i}
            x={x(p.t) - 4}
            y={0}
            width={8}
            height={IH}
            fill="transparent"
            onMouseEnter={() =>
              setTip({
                x: M.left + x(p.t),
                y: M.top + y(p.total),
                text: (
                  <>
                    <b>{fmtT(p.t)}</b>
                    <br />
                    total {fmt(p.total)} · coding {fmt(p.coding)}
                    <br />
                    evaluator {fmt(p.evaluator)} · research {fmt(p.research)}
                  </>
                ),
              })
            }
            onMouseLeave={() => setTip(null)}
          />
        ))}
      </Frame>
      <div className="legend">
        <span><i className="sw series-1" />Total</span>
        <span><i className="sw series-2" />Coding</span>
        <span><i className="sw series-3" />Evaluator</span>
        <span><i className="sw series-4" />Research</span>
      </div>
    </>
  );
}
