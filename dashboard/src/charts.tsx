/**
 * Hand-rolled SVG charts following the monochrome dashboard chart spec
 * (basic-dashboard-styling SKILL.md § Charts): 100% of the panel width, 256px tall,
 * dashed hairline grid, mono 11px ticks, ink primary series, greys for the rest,
 * green/red only when a mark means good/bad, square marks, no animation.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fmtTokens } from './format';

export const CHART_H = 256;
const M = { top: 12, right: 12, bottom: 24, left: 56 };

/** Measure the container's width so the SVG is drawn at real pixels (text never scales). */
export function useWidth<T extends HTMLElement>(fallback = 640): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setW(Math.max(200, Math.floor(el.getBoundingClientRect().width)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceTicks(min: number, max: number, count = 4): number[] {
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
  // Always end on a tick >= max so every mark stays inside the plot.
  for (let v = start; ; v += step) {
    ticks.push(Number(v.toFixed(10)));
    if (v >= max - 1e-9 || ticks.length > 50) break;
  }
  return ticks;
}

function linear(d0: number, d1: number, r0: number, r1: number) {
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** Every n-th category label so labels of ~`px` width never overlap. */
const labelStep = (n: number, iw: number, px: number) => Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / px))));

interface Tip {
  x: number;
  y: number;
  text: ReactNode;
}

export function ChartEmpty({ children }: { children: ReactNode }) {
  return <p className="chart-empty">{children}</p>;
}

/** Legend centred under a chart: square swatches, line swatches for lines, dashed for targets. */
export function Legend({ items }: { items: { label: string; color: string; kind?: 'square' | 'line' | 'dash' }[] }) {
  return (
    <div className="ds-legend">
      {items.map((i) => (
        <span key={i.label} className="ds-legend__item">
          <span
            className={'ds-legend__swatch' + (i.kind === 'line' ? ' ds-legend__swatch--line' : i.kind === 'dash' ? ' ds-legend__swatch--dash' : '')}
            style={{ ['--c' as string]: `var(${i.color})` }}
          />
          {i.label}
        </span>
      ))}
    </div>
  );
}

function Frame({
  width,
  height = CHART_H,
  yTicks,
  y,
  yFmt,
  xGrid = [],
  children,
  tip,
  ariaLabel,
}: {
  width: number;
  height?: number;
  yTicks: number[];
  y: (v: number) => number;
  yFmt: (v: number) => string;
  xGrid?: number[];
  children: ReactNode;
  tip: Tip | null;
  ariaLabel: string;
}) {
  const iw = width - M.left - M.right;
  const ih = height - M.top - M.bottom;
  return (
    <>
      <svg width={width} height={height} role="img" aria-label={ariaLabel}>
        <g transform={`translate(${M.left},${M.top})`}>
          {yTicks.map((t) => (
            <g key={t}>
              <line className="grid" x1={0} x2={iw} y1={y(t)} y2={y(t)} />
              <text className="tick" x={-8} y={y(t)} dy="0.32em" textAnchor="end">
                {yFmt(t)}
              </text>
            </g>
          ))}
          {xGrid.map((gx, i) => (
            <line key={'xg' + i} className="grid" x1={gx} x2={gx} y1={0} y2={ih} />
          ))}
          <line className="axis" x1={0} x2={0} y1={0} y2={ih} />
          <line className="axis" x1={0} x2={iw} y1={ih} y2={ih} />
          {children}
        </g>
      </svg>
      {tip && (
        <div className="chart-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

export interface StepPoint {
  label: string;
  value: number | null; // running best (null until first verified)
  raw: number | null; // this experiment's own median tokens
  passed: boolean | null;
}

/** Running best as the primary (ink) step line; each experiment's own median as a green/red dot. */
export function StepLineChart({ points }: { points: StepPoint[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const vals = points.flatMap((p) => [p.value, p.raw]).filter((v): v is number => v !== null);
  if (!points.length || !vals.length) return <ChartEmpty>No experiment has a token median yet.</ChartEmpty>;
  const iw = width - M.left - M.right;
  const ih = CHART_H - M.top - M.bottom;
  const yTicks = niceTicks(0, Math.max(...vals));
  const y = linear(0, yTicks[yTicks.length - 1], ih, 0);
  const slot = iw / points.length;
  const x = (i: number) => slot * (i + 0.5);
  let d = '';
  let prev: number | null = null;
  points.forEach((p, i) => {
    if (p.value === null) return;
    if (prev === null) d += `M${x(i)},${y(p.value)}`;
    else d += `H${x(i)}V${y(p.value)}`;
    prev = p.value;
  });
  if (prev !== null) d += `H${x(points.length - 1)}`;
  const every = labelStep(points.length, iw, 72);
  return (
    <div className="chart" ref={ref}>
      <Frame width={width} yTicks={yTicks} y={y} yFmt={fmtTokens} xGrid={points.map((_, i) => x(i)).filter((_, i) => i % every === 0)} tip={tip} ariaLabel="Best verified tokens over experiments">
        {points.map((p, i) =>
          i % every === 0 ? (
            <text key={'l' + i} className="tick" x={x(i)} y={ih + 16} textAnchor="middle">
              {p.label}
            </text>
          ) : null,
        )}
        <path className="line s-primary" d={d} />
        {points.map((p, i) =>
          p.raw === null ? null : (
            <g key={i}>
              <circle cx={x(i)} cy={y(p.raw)} r={3} className={p.passed ? 'dot-pass' : 'dot-fail'} />
              <rect
                className="hit"
                x={x(i) - slot / 2}
                y={0}
                width={slot}
                height={ih}
                onMouseEnter={() =>
                  setTip({
                    x: M.left + x(i),
                    y: M.top + y(p.raw!),
                    text: (
                      <>
                        <b>{p.label}</b> · median {fmtTokens(p.raw)} · {p.passed ? 'verified' : 'not verified'}
                        <br />
                        best so far {fmtTokens(p.value)}
                      </>
                    ),
                  })
                }
                onMouseLeave={() => setTip(null)}
              />
            </g>
          ),
        )}
      </Frame>
    </div>
  );
}
