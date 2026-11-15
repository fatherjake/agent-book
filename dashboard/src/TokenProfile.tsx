/**
 * "Token profile" section of the run view: where the coding session's tokens went.
 * Data: results/runs/<id>/profile.json (researcher/session-profile.ts), served via /artifacts.
 * Token counts per call are exact (gateway usage records); tool-output tokens are estimates (chars/4).
 */
import { useState } from 'react';
import { CHART_H, useWidth } from './charts';
import { useApi } from './api';
import type { SessionProfileView } from './api-types';
import { fmtInt, fmtTokens } from './format';

type Call = SessionProfileView['calls'][number];

const SEGMENTS: { key: 'cacheReadTokens' | 'cacheWriteTokens' | 'inputTokens' | 'outputTokens'; label: string; cls: string }[] = [
  { key: 'cacheReadTokens', label: 'Cache read', cls: 'seg-cr' },
  { key: 'cacheWriteTokens', label: 'Cache write', cls: 'seg-cw' },
  { key: 'inputTokens', label: 'Input', cls: 'seg-in' },
  { key: 'outputTokens', label: 'Output', cls: 'seg-out' },
];

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * mag).find((s) => s >= v) ?? v) as number;
}

function CallBars({ calls, overhead }: { calls: Call[]; overhead: number | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, W] = useWidth<HTMLDivElement>();
  const H = CHART_H;
  const M = { top: 12, right: 12, bottom: 24, left: 56 };
  const IW = W - M.left - M.right;
  const IH = H - M.top - M.bottom;
  const max = niceMax(Math.max(...calls.map((c) => c.totalTokens), 1));
  const y = (v: number) => IH - (v / max) * IH;
  const slot = IW / calls.length;
  const bw = Math.max(2, Math.min(48, slot * 0.7));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.ceil(calls.length / 20);
  const h = hover === null ? null : calls[hover];
  return (
    <>
    <div className="chart" ref={ref}>
      <svg width={W} height={H} role="img" aria-label="Tokens per model call, stacked by kind">
        <g transform={`translate(${M.left},${M.top})`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={0} x2={IW} y1={y(t)} y2={y(t)} />
              <text className="tick" x={-8} y={y(t)} dy="0.32em" textAnchor="end">
                {fmtTokens(t)}
              </text>
            </g>
          ))}
          <line className="axis" x1={0} x2={0} y1={0} y2={IH} />
          <line className="axis" x1={0} x2={IW} y1={IH} y2={IH} />
          {hover !== null && <rect className="cursor" x={hover * slot} y={0} width={slot} height={IH} />}
          {calls.map((c, i) => {
            const x = i * slot + (slot - bw) / 2;
            let acc = 0;
            return (
              <g key={c.index} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} className={hover === i ? 'bar-group hover' : 'bar-group'}>
                <rect className="hit" x={i * slot} y={0} width={slot} height={IH} />
                {SEGMENTS.map((s) => {
                  const v = c[s.key];
                  if (!v) return null;
                  const y0 = y(acc + v);
                  const hh = y(acc) - y0;
                  acc += v;
                  return <rect key={s.key} className={s.cls} x={x} y={y0} width={bw} height={Math.max(hh, 0.5)} />;
                })}
                {c.thread !== 'main' && (
                  <text className="tick" x={x + bw / 2} y={y(c.totalTokens) - 4} textAnchor="middle">
                    {c.purpose === 'background' ? 'bg' : 'sub'}
                  </text>
                )}
                {i % labelEvery === 0 && (
                  <text className="tick" x={i * slot + slot / 2} y={IH + 16} textAnchor="middle">
                    #{c.index}
                  </text>
                )}
              </g>
            );
          })}
          {overhead !== null && overhead > 0 && overhead < max && (
            <g>
              <line className="threshold" x1={0} x2={IW} y1={y(overhead)} y2={y(overhead)} />
              <text className="tick halo" x={IW - 4} y={y(overhead) - 5} textAnchor="end">
                est. fixed overhead {fmtTokens(overhead)}/call
              </text>
            </g>
          )}
        </g>
      </svg>
      {h && hover !== null && (
        <div className="chart-tip" style={{ left: M.left + hover * slot + slot / 2, top: M.top + y(h.totalTokens) }}>
          <b>
            #{h.index} {h.purpose}
          </b>{' '}
          · ctx {fmtTokens(h.contextTokens)}
          {h.contextDelta !== null && ` (${h.contextDelta >= 0 ? '+' : ''}${fmtTokens(h.contextDelta)})`}
          <br />
          cache read {fmtInt(h.cacheReadTokens)} · write {fmtInt(h.cacheWriteTokens)} · in {fmtInt(h.inputTokens)} · out {fmtInt(h.outputTokens)}
          {h.thinkingTokens > 0 && ` (thinking ${fmtInt(h.thinkingTokens)})`}
          <br />
          {h.tools.length ? h.tools.join(', ') : h.textChars ? `text ${h.textChars} chars` : 'no tool call'}
        </div>
      )}
    </div>
      <div className="legend">
        {SEGMENTS.map((s) => (
          <span key={s.key}>
            <i className={'sq ' + s.cls} />
            {s.label}
          </span>
        ))}
        {overhead !== null && overhead > 0 && (
          <span>
            <span className="ds-legend__swatch ds-legend__swatch--dash" />
            Fixed overhead (est.)
          </span>
        )}
      </div>
    </>
  );
}

const SEV_CLASS: Record<string, string> = { high: 'fail', medium: 'warn', low: 'neutral', info: 'neutral' };

export function TokenProfile({ url }: { url: string | null | undefined }) {
  if (!url) return <div className="empty">No token profile for this run (generate one with tsx scripts/profile-run.ts &lt;runId&gt;).</div>;
  return <TokenProfileLoaded url={url} />;
}

function TokenProfileLoaded({ url }: { url: string }) {
  const state = useApi<SessionProfileView>(url);
  if (state.loading) return <div className="empty">Loading profile…</div>;
  if (state.error || !state.data) return <div className="error-box">Could not load profile.json: {state.error}</div>;
  const p = state.data;
  const t = p.totals;
  const o = p.overhead;
  const share = (n: number) => (t.totalTokens ? ((n / t.totalTokens) * 100).toFixed(0) + '%' : '—');
  const costly = [...p.tools].sort((a, b) => b.carriedTokensEst - a.carriedTokensEst || b.outputTokensEst - a.outputTokensEst).slice(0, 8);
  const main = p.calls.filter((c) => c.thread === 'main');
  const last = main[main.length - 1];
  return (
    <div className="token-profile">
      <div className="kv">
        <span>Total</span>
        <b>
          {fmtInt(t.totalTokens)} tok over {t.modelCalls} calls · cache read {share(t.cacheReadTokens)} · cache write {share(t.cacheWriteTokens)} · output {share(t.outputTokens)} · input{' '}
          {share(t.inputTokens)}
          {t.thinkingTokens > 0 && ` · thinking ${fmtInt(t.thinkingTokens)} (in output)`}
        </b>
        <span>By purpose</span>
        <b>
          {Object.entries(p.byPurpose)
            .map(([k, v]) => `${k}: ${v.calls} calls, ${fmtTokens(v.totalTokens)}`)
            .join(' · ')}
        </b>
        <span title={o.method}>Fixed overhead (est.)</span>
        <b title={o.method}>
          {o.fixedOverheadTokensEst === null ? (
            '—'
          ) : (
            <>
              ≈{fmtTokens(o.fixedOverheadTokensEst)}/call (first context {fmtTokens(o.firstCallContextTokens)} − task prompt ≈{fmtTokens(o.userPromptTokensEst)}) ·{' '}
              <span className="strong">{o.overheadShareOfTotal === null ? '—' : (o.overheadShareOfTotal * 100).toFixed(0) + '%'} of total</span> · re-read ≈
              {fmtTokens(o.overheadReReadTokensEst)}
            </>
          )}
        </b>
        {last && main.length > 1 && (
          <>
            <span>Context growth</span>
            <b>
              {fmtTokens(main[0].contextTokens)} → {fmtTokens(last.contextTokens)}; final turn #{last.index} cost {fmtTokens(last.totalTokens)} ({share(last.totalTokens)})
            </b>
          </>
        )}
      </div>

      {p.calls.length > 0 ? <CallBars calls={p.calls} overhead={o.fixedOverheadTokensEst} /> : <div className="empty">No model calls recorded.</div>}

      <h3 className="subhead">Waste signals</h3>
      {p.waste.length === 0 ? (
        <div className="empty">None detected.</div>
      ) : (
        <ul className="waste-list">
          {p.waste.map((w, i) => (
            <li key={i}>
              <details>
                <summary>
                  <span className={'badge ' + SEV_CLASS[w.severity]}>{w.severity}</span> <span className="mono small">{w.kind}</span> {w.title}
                  {w.tokens > 0 && (
                    <span className="muted small">
                      {' '}
                      · {w.tokensEstimated ? '≈' : ''}
                      {fmtTokens(w.tokens)} tok{w.tokensEstimated ? ' (est.)' : ''}
                    </span>
                  )}
                </summary>
                <ul className="evidence-list">
                  {w.evidence.map((e, k) => (
                    <li key={k} className="mono small">
                      {e}
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      )}

      <h3 className="subhead">Costliest tool outputs</h3>
      {costly.length === 0 ? (
        <div className="empty">No tool calls.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Call</th>
                <th>Tool</th>
                <th>Input</th>
                <th className="num">Output chars</th>
                <th className="num" title="Estimated: chars / 4, images ≈ w×h/750">Est. tokens</th>
                <th className="num" title="Estimated tokens × later calls that carry this output">Carried (est.)</th>
              </tr>
            </thead>
            <tbody>
              {costly.map((x) => (
                <tr key={x.id} className={x.isError ? 'outcome-fail' : ''}>
                  <td className="mono">{x.callIndex === null ? '?' : '#' + x.callIndex}</td>
                  <td>
                    {x.name} {x.isError && <span className="badge fail">error</span>}
                  </td>
                  <td className="mono small tp-input" title={x.inputSummary}>{x.inputSummary}</td>
                  <td className="num">
                    {fmtInt(x.outputChars)}
                    {x.images > 0 && ` + ${x.images} img`}
                  </td>
                  <td className="num">{fmtInt(x.outputTokensEst)}</td>
                  <td className="num strong">
                    {fmtInt(x.carriedTokensEst)} <span className="muted small">×{x.remainingCalls}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {p.notes.length > 0 && <p className="muted small">{p.notes.join(' ')}</p>}
      <p className="muted small">
        Per-call tokens are exact (gateway usage records). Tool-output tokens, carried cost and fixed overhead are estimates.{' '}
        <a href={url} target="_blank" rel="noreferrer">
          profile.json
        </a>
      </p>
    </div>
  );
}
