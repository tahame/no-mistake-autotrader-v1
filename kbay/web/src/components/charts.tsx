import { type KeyboardEvent, type PointerEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';
import { dateLabel, rs } from '../format';

// Small hand-rolled SVG charts. No chart library: every mark is drawn here, so the charts stay
// light on a phone, follow the app's light/dark tokens and print cleanly.
//
// Colour: two validated categorical slots (blue, orange) checked for colour-blind separation and
// 3:1 contrast against the app's panel in both modes. Text never wears a series colour; legends
// and tooltips key series with a short line or swatch. Every chart has a table of its numbers.

const CSS = `
:root { --viz-1: #2a78d6; --viz-2: #eb6834; --viz-axis: #cfc9c0; }
@media (prefers-color-scheme: dark) { :root { --viz-1: #3987e5; --viz-2: #d95926; --viz-axis: #4a433e; } }
@media print {
  html:has(.kbay-print-area) { --bg: #fff; --panel: #fff; --panel-2: #f4f2ee; --line: #ddd8d0; --ink: #111; --muted: #555;
    --good: #15803d; --bad: #b91c1c; --warn: #b45309; --viz-1: #2a78d6; --viz-2: #eb6834; --viz-axis: #bdb6ab; color-scheme: light; }
  body:has(.kbay-print-area) { background: #fff !important; color: #111 !important; }
  body:has(.kbay-print-area) aside, body:has(.kbay-print-area) header, body:has(.kbay-print-area) nav { display: none !important; }
  body:has(.kbay-print-area) main { max-width: none !important; padding: 0 !important; }
  .kbay-print-area { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .kbay-print-area section, .kbay-print-area table tr { break-inside: avoid; }
  .kbay-print-area details { display: block; }
  .kbay-print-area details > *:not(summary) { display: block; }
}
`;

if (typeof document !== 'undefined' && !document.getElementById('kbay-viz-css')) {
  const el = document.createElement('style');
  el.id = 'kbay-viz-css';
  el.textContent = CSS;
  document.head.appendChild(el);
}

export const VIZ = { s1: 'var(--viz-1)', s2: 'var(--viz-2)' };

/** "Rs 2.5K", "Rs 1.2M" — for axis ticks and tight labels. Full figures live in tables and tooltips. */
export function compactRs(minor: number) {
  const v = minor / 100;
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  const trim = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ''));
  if (a >= 1e6) return `${sign}Rs ${trim(a / 1e6)}M`;
  if (a >= 1e3) return `${sign}Rs ${trim(a / 1e3)}K`;
  return `${sign}Rs ${Math.round(a)}`;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.floor(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((e) => setW(Math.floor(e[0]?.contentRect.width ?? 0)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceTicks(min: number, max: number, count = 4) {
  if (max === min) max = min + 100_00;
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v));
  return out;
}

const dayNum = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;
const shortDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-PK', { day: 'numeric', month: 'short' });

/** Column top / bar end with 4px rounded data-end, square at the baseline. */
function columnPath(x: number, y0: number, w: number, h: number) {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  const top = y0 - h;
  return `M${x},${y0}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${y0}Z`;
}
function barPath(x0: number, y: number, len: number, h: number) {
  if (len <= 0) return '';
  const r = Math.min(4, h / 2, len);
  const end = x0 + len;
  return `M${x0},${y}H${end - r}Q${end},${y} ${end},${y + r}V${y + h - r}Q${end},${y + h} ${end - r},${y + h}H${x0}Z`;
}

function Tip({ x, top, width, children }: { x: number; top: number; width: number; children: ReactNode }) {
  const tw = 184;
  const left = Math.min(Math.max(x - tw / 2, 0), Math.max(0, width - tw));
  return (
    <div className="pointer-events-none absolute z-10 rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs shadow-lg print:hidden"
      style={{ left, top, width: tw }}>
      {children}
    </div>
  );
}

function TipRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="mt-1 flex items-center gap-2">
      <span className="inline-block h-0.5 w-3 rounded" style={{ background: color }} aria-hidden />
      <span className="text-[var(--muted)]">{label}</span>
      <b className="ml-auto tabular text-[var(--ink)]">{value}</b>
    </div>
  );
}

export function Legend({ items, kind = 'line' }: { items: { name: string; color: string }[]; kind?: 'line' | 'box' }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted)]">
      {items.map((s) => (
        <span key={s.name} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={kind === 'line' ? 'inline-block h-0.5 w-4 rounded' : 'inline-block h-2.5 w-2.5 rounded-sm'} style={{ background: s.color }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

function NumbersTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <details className="mt-3 text-sm print:hidden">
      <summary className="cursor-pointer text-xs text-[var(--muted)] underline-offset-2 hover:underline">See the numbers</summary>
      <div className="mt-2 max-h-72 overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--line)] text-left text-xs text-[var(--muted)]">
              {head.map((h, i) => <th key={h} className={i > 0 ? 'px-2 py-1 text-right font-medium' : 'px-2 py-1 font-medium'}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-[var(--line)] last:border-0">
                {r.map((c, j) => <td key={j} className={j > 0 ? 'px-2 py-1 text-right tabular' : 'px-2 py-1'}>{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------- Trend (line) chart

export interface TrendSeries { name: string; color: string }

/** Daily values over time on one money axis, with crosshair + tooltip and a table view. */
export function TrendChart({ title, data, series, height = 240 }: {
  title: string; data: { date: string; values: number[] }[]; series: TrendSeries[]; height?: number;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  const W = Math.max(w, 260);
  const H = height;
  const m = { l: 56, r: 14, t: 12, b: 28 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const n = data.length;

  const all = data.flatMap((d) => d.values);
  const yt = niceTicks(Math.min(0, ...all), Math.max(0, ...all), 4);
  const y0 = yt[0]!;
  const y1 = yt[yt.length - 1]!;
  const y = (v: number) => m.t + ih - ((v - y0) / (y1 - y0)) * ih;
  const t0 = n ? dayNum(data[0]!.date) : 0;
  const t1 = n ? dayNum(data[n - 1]!.date) : 0;
  const x = (d: string) => (t1 === t0 ? m.l + iw / 2 : m.l + ((dayNum(d) - t0) / (t1 - t0)) * iw);

  const xCount = Math.max(2, Math.min(n, Math.floor(iw / 84)));
  const xIdx = n <= 1 ? [0] : [...new Set(Array.from({ length: xCount }, (_, i) => Math.round((i * (n - 1)) / (xCount - 1))))];

  const path = (si: number) => data.map((d, i) => `${i ? 'L' : 'M'}${x(d.date).toFixed(1)},${y(d.values[si] ?? 0).toFixed(1)}`).join('');
  const area = n > 1 && data.every((d) => (d.values[0] ?? 0) >= 0)
    ? `${path(0)}L${x(data[n - 1]!.date).toFixed(1)},${y(0)}L${x(data[0]!.date).toFixed(1)},${y(0)}Z` : '';

  const nearest = (px: number) => {
    let best = 0;
    let bd = Infinity;
    data.forEach((d, i) => { const dd = Math.abs(x(d.date) - px); if (dd < bd) { bd = dd; best = i; } });
    return best;
  };
  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect();
    setHover(nearest(e.clientX - r.left));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight') setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? n) - 1));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };

  const first = data[0];
  const last = data[n - 1];
  const summary = n && first && last
    ? `${title}. ${n} days from ${dateLabel(first.date)} to ${dateLabel(last.date)}. ` +
      series.map((s, i) => `${s.name}: ${rs(first.values[i])} on the first day, ${rs(last.values[i])} on the last day.`).join(' ')
    : `${title}. No data.`;
  const hd = hover !== null ? data[hover] : undefined;

  return (
    <div>
      {series.length > 1 && <div className="mb-2"><Legend items={series} /></div>}
      <div ref={ref} className="relative w-full">
        {w > 0 && (
          <svg width={W} height={H} role="img" aria-labelledby={titleId} tabIndex={0} onKeyDown={onKey} onBlur={() => setHover(null)}
            className="block overflow-visible outline-none focus-visible:ring-2 focus-visible:ring-brand/40 rounded">
            <title id={titleId}>{summary}</title>
            {yt.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--viz-axis)' : 'var(--line)'} strokeWidth={1} />
                <text x={m.l - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)" className="tabular">{compactRs(t)}</text>
              </g>
            ))}
            {xIdx.map((i) => (
              <text key={i} x={x(data[i]!.date)} y={H - 8} fontSize={11} fill="var(--muted)"
                textAnchor={xIdx.length > 1 && i === 0 ? 'start' : xIdx.length > 1 && i === n - 1 ? 'end' : 'middle'}>{shortDate(data[i]!.date)}</text>
            ))}
            {area && <path d={area} fill={series[0]!.color} opacity={0.1} />}
            {series.map((s, si) => n > 1 && (
              <path key={s.name} d={path(si)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {last && series.map((s, si) => (
              <circle key={s.name} cx={x(last.date)} cy={y(last.values[si] ?? 0)} r={4} fill={s.color} stroke="var(--panel)" strokeWidth={2} />
            ))}
            {hd && (
              <g pointerEvents="none">
                <line x1={x(hd.date)} x2={x(hd.date)} y1={m.t} y2={m.t + ih} stroke="var(--muted)" strokeWidth={1} />
                {series.map((s, si) => (
                  <circle key={s.name} cx={x(hd.date)} cy={y(hd.values[si] ?? 0)} r={4.5} fill={s.color} stroke="var(--panel)" strokeWidth={2} />
                ))}
              </g>
            )}
            <rect x={m.l} y={m.t} width={iw} height={ih} fill="transparent" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} />
          </svg>
        )}
        {w === 0 && <div style={{ height: H }} />}
        {hd && (
          <Tip x={x(hd.date)} top={4} width={W}>
            <div className="font-medium text-[var(--ink)]">{dateLabel(hd.date)}</div>
            {series.map((s, si) => <TipRow key={s.name} color={s.color} label={s.name} value={rs(hd.values[si])} />)}
          </Tip>
        )}
      </div>
      <NumbersTable head={['Date', ...series.map((s) => s.name)]} rows={data.map((d) => [dateLabel(d.date), ...d.values.map((v) => rs(v))])} />
    </div>
  );
}

// ---------------------------------------------------------------- Sparkline

/** A tiny trend line for a stat tile: last point marked, no axes. */
export function Sparkline({ values, label, height = 36 }: { values: number[]; label: string; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const n = values.length;
  const max = Math.max(...values, 1);
  const min = Math.min(0, ...values);
  const pad = 5;
  const x = (i: number) => (n <= 1 ? w / 2 : pad + (i / (n - 1)) * (w - pad * 2));
  const y = (v: number) => pad + (1 - (v - min) / (max - min || 1)) * (height - pad * 2);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return (
    <div ref={ref} className="w-full" style={{ height }}>
      {w > 0 && n > 0 && (
        <svg width={w} height={height} role="img" aria-label={label} className="block overflow-visible">
          <title>{label}</title>
          {n > 1 && <path d={d} fill="none" stroke={VIZ.s1} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
          <circle cx={x(n - 1)} cy={y(values[n - 1]!)} r={4} fill={VIZ.s1} stroke="var(--panel)" strokeWidth={2} />
        </svg>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Bar list (horizontal)

/**
 * Horizontal bars for comparing named things (expense heads, stalls). Each row shows its label and
 * value(s) as text, so nothing depends on hovering. One or two series on one shared scale.
 */
export function BarList({ title, rows, series, format = rs }: {
  title: string; rows: { key: string; label: string; values: number[] }[]; series: TrendSeries[]; format?: (v: number) => string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const max = Math.max(1, ...rows.flatMap((r) => r.values));
  const bh = series.length > 1 ? 10 : 14;
  const gap = 2;
  const svgH = series.length * bh + (series.length - 1) * gap;
  return (
    <figure aria-label={title} className="m-0">
      {series.length > 1 && <div className="mb-3"><Legend items={series} kind="box" /></div>}
      <div ref={ref} className="space-y-3">
        {rows.map((r) => (
          <div key={r.key} className="rounded-lg px-1 py-0.5 hover:bg-[var(--panel-2)]">
            <div className={series.length > 1
              ? 'flex flex-col gap-0.5 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-3'
              : 'flex items-baseline justify-between gap-3 text-sm'}>
              <span className="min-w-0 truncate">{r.label}</span>
              <span className="shrink-0 tabular text-[var(--ink)]">
                {r.values.map((v, i) => (
                  <span key={i} className={i > 0 ? (v < 0 ? 'ml-3 text-[var(--bad)]' : 'ml-3 text-[var(--muted)]') : 'font-semibold'}>
                    {series.length > 1 && i > 0 ? `${series[i]!.name}: ` : ''}{format(v)}
                  </span>
                ))}
              </span>
            </div>
            {w > 0 && (
              <svg width={w - 8} height={svgH} className="mt-1 block" aria-hidden>
                {r.values.map((v, i) => (
                  <path key={i} d={barPath(0, i * (bh + gap), (Math.max(0, v) / max) * (w - 8), bh)} fill={series[i]?.color ?? VIZ.s1} />
                ))}
                {r.values.length === 0 || r.values.every((v) => v <= 0) ? <line x1={0} x2={0} y1={0} y2={svgH} stroke="var(--viz-axis)" /> : null}
              </svg>
            )}
          </div>
        ))}
      </div>
    </figure>
  );
}

// ---------------------------------------------------------------- Column chart (hours)

/** Vertical columns along an ordered axis (hours of the day), peak labelled, per-column tooltip. */
export function ColumnChart({ title, rows, height = 220, valueLabel = 'Sales', extra }: {
  title: string; rows: { key: string; label: string; value: number; extra?: string }[]; height?: number; valueLabel?: string; extra?: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  const W = Math.max(w, 260);
  const m = { l: 52, r: 8, t: 22, b: 26 };
  const iw = W - m.l - m.r;
  const ih = height - m.t - m.b;
  const n = rows.length;
  const yt = niceTicks(0, Math.max(0, ...rows.map((r) => r.value)), 4);
  const top = yt[yt.length - 1]!;
  const y = (v: number) => m.t + ih - (v / top) * ih;
  const band = n ? iw / n : iw;
  const bw = Math.max(2, Math.min(24, band - 2));
  const cx = (i: number) => m.l + band * i + band / 2;
  const peak = rows.reduce((b, r, i) => (r.value > (rows[b]?.value ?? -1) ? i : b), 0);
  const every = Math.max(1, Math.ceil(36 / band));
  const summary = n ? `${title}. Busiest: ${rows[peak]!.label} with ${rs(rows[peak]!.value)}.` : `${title}. No data.`;
  const hr = hover !== null ? rows[hover] : undefined;
  return (
    <div>
      <div ref={ref} className="relative w-full">
        {w > 0 && (
          <svg width={W} height={height} role="img" aria-labelledby={titleId} className="block overflow-visible">
            <title id={titleId}>{summary}</title>
            {yt.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--viz-axis)' : 'var(--line)'} strokeWidth={1} />
                <text x={m.l - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)" className="tabular">{compactRs(t)}</text>
              </g>
            ))}
            {rows.map((r, i) => (
              <g key={r.key}>
                <path d={columnPath(cx(i) - bw / 2, y(0), bw, y(0) - y(r.value))} fill={VIZ.s1} opacity={hover === null || hover === i ? 1 : 0.55} />
                {i % every === 0 && <text x={cx(i)} y={height - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">{r.label}</text>}
                <rect x={m.l + band * i} y={m.t} width={band} height={ih} fill="transparent" tabIndex={0}
                  aria-label={`${r.label}: ${rs(r.value)}${r.extra ? `, ${r.extra}` : ''}`}
                  onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                  className="outline-none" />
              </g>
            ))}
            {n > 0 && rows[peak]!.value > 0 && (
              <text x={cx(peak)} y={y(rows[peak]!.value) - 6} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--ink)" pointerEvents="none">
                {compactRs(rows[peak]!.value)}
              </text>
            )}
          </svg>
        )}
        {w === 0 && <div style={{ height }} />}
        {hr && hover !== null && (
          <Tip x={cx(hover)} top={0} width={W}>
            <div className="font-medium text-[var(--ink)]">{hr.label}</div>
            <TipRow color={VIZ.s1} label={valueLabel} value={rs(hr.value)} />
            {hr.extra && <div className="mt-1 text-[var(--muted)]">{hr.extra}</div>}
          </Tip>
        )}
      </div>
      <NumbersTable head={['', valueLabel, ...(extra ? [extra] : [])]} rows={rows.map((r) => [r.label, rs(r.value), ...(extra ? [r.extra ?? ''] : [])])} />
    </div>
  );
}
