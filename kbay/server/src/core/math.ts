// Exact arithmetic for money and quantities. No floating point touches a stored number.
//
// Money: integer minor units (paisa). Quantities: integer "milli" of the item's base unit
// (1 g = 1000 milli-g), matching the database numeric(18,3) columns.

/** Round a / b to the nearest integer, halves away from zero. Inputs must be integers. */
export function divRound(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error('division by zero');
  const neg = a < 0n !== b < 0n;
  const absA = a < 0n ? -a : a;
  const absB = b < 0n ? -b : b;
  const q = (absA * 2n + absB) / (absB * 2n);
  return neg ? -q : q;
}

/** round(a * b / c) computed exactly in bigint, returned as a safe JS integer. */
export function mulDiv(a: number, b: number, c: number): number {
  assertInt(a, 'a');
  assertInt(b, 'b');
  assertInt(c, 'c');
  const r = divRound(BigInt(a) * BigInt(b), BigInt(c));
  return toSafe(r);
}

/** Apply basis points (1 bps = 0.01%) to a minor amount, rounded half away from zero. */
export function applyBps(amountMinor: number, bps: number): number {
  return mulDiv(amountMinor, bps, 10000);
}

export function assertInt(n: number, name = 'value'): void {
  if (!Number.isSafeInteger(n)) throw new Error(`${name} must be a safe integer, got ${n}`);
}

function toSafe(b: bigint): number {
  if (b > BigInt(Number.MAX_SAFE_INTEGER) || b < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error('integer overflow');
  }
  return Number(b);
}

/** Parse a decimal string/number with up to 3 decimals into integer milli-units. */
export function toMilli(v: string | number): number {
  const s = typeof v === 'number' ? v.toString() : v.trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,3})\d*)?$/.exec(s);
  if (!m) throw new Error(`invalid quantity: ${v}`);
  // Extra precision past 3 decimals is rejected rather than silently rounded.
  const extra = /^-?\d+\.\d{3}(\d+)$/.exec(s);
  if (extra && /[1-9]/.test(extra[1]!)) throw new Error(`quantity has more than 3 decimals: ${v}`);
  const whole = BigInt(m[2]!);
  const frac = BigInt((m[3] ?? '').padEnd(3, '0'));
  const r = whole * 1000n + frac;
  return toSafe(m[1] ? -r : r);
}

/** Integer milli-units to a decimal string with 3 decimals (for numeric columns). */
export function fromMilli(milli: number): string {
  assertInt(milli, 'milli');
  const neg = milli < 0;
  const abs = Math.abs(milli);
  const s = `${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, '0')}`;
  return neg ? `-${s}` : s;
}

/**
 * Split a total across weights so the parts always add back to the total exactly
 * (largest-remainder method). Used for partner profit shares.
 */
export function allocate(totalMinor: number, weights: number[]): number[] {
  assertInt(totalMinor, 'total');
  if (weights.length === 0) return [];
  const scaled = weights.map((w) => {
    if (!(w >= 0)) throw new Error('weights must be non-negative');
    return BigInt(Math.round(w * 1_000_000));
  });
  const sum = scaled.reduce((a, b) => a + b, 0n);
  if (sum === 0n) throw new Error('weights sum to zero');
  const total = BigInt(totalMinor);
  const sign = total < 0n ? -1n : 1n;
  const absTotal = total * sign;
  const base = scaled.map((w) => (absTotal * w) / sum);
  const remainders = scaled.map((w, i) => ({ i, r: (absTotal * w) % sum }));
  let left = absTotal - base.reduce((a, b) => a + b, 0n);
  remainders.sort((x, y) => (y.r > x.r ? 1 : y.r < x.r ? -1 : x.i - y.i));
  for (const { i } of remainders) {
    if (left === 0n) break;
    base[i] = base[i]! + 1n;
    left -= 1n;
  }
  return base.map((b) => toSafe(b * sign));
}
