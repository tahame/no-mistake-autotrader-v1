// Display helpers. Money is stored in paisa; the UI shows rupees.

export function rs(minor: number | null | undefined, opts: { sign?: boolean } = {}) {
  if (minor === null || minor === undefined) return '—';
  const v = minor / 100;
  const s = Math.abs(v).toLocaleString('en-PK', { minimumFractionDigits: v % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
  const sign = v < 0 ? '−' : opts.sign && v > 0 ? '+' : '';
  return `${sign}Rs ${s}`;
}

/** Parse a rupee amount typed by a person ("1,250.50") into paisa. Returns null if invalid. */
export function toMinor(input: string): number | null {
  const t = input.replace(/[,\s]/g, '').replace(/^rs\.?/i, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
}

export function fromMinorInput(minor: number) {
  return minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2);
}

export function qtyDisplay(qty: string | number, unit?: string) {
  const n = Number(qty);
  const s = n.toLocaleString('en-PK', { maximumFractionDigits: 3 });
  return unit ? `${s} ${unit}` : s;
}

export function dateLabel(d: string | Date | null | undefined) {
  if (!d) return '—';
  const dt = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T12:00:00`) : new Date(d);
  return dt.toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function timeLabel(d: string | Date | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-PK', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

/** Today's date in Pakistan time, YYYY-MM-DD. */
export function todayPk() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function daysAgo(n: number) {
  const d = new Date(`${todayPk()}T12:00:00`);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export function monthStart() {
  return `${todayPk().slice(0, 8)}01`;
}
