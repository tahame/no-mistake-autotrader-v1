import { describe, expect, it } from 'vitest';
import { allocate, applyBps, divRound, fromMilli, mulDiv, toMilli } from '../src/core/math.js';
import { fromBaseMilli, toBaseMilli } from '../src/core/units.js';
import { computeTotals } from '../src/modules/orders/service.js';

describe('exact arithmetic', () => {
  it('rounds halves away from zero', () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(4n, 3n)).toBe(1n);
    expect(divRound(-4n, 3n)).toBe(-1n);
  });

  it('mulDiv is exact beyond 2^53 intermediates', () => {
    // 90,000,000 rupees of stock (9e9 paisa) valued over 9e9 milligrams: product is 8.1e19.
    expect(mulDiv(9_000_000_000, 9_000_000_000, 9_000_000_000)).toBe(9_000_000_000);
    expect(mulDiv(10, 1, 3)).toBe(3);
    expect(mulDiv(20, 1, 3)).toBe(7);
  });

  it('applies basis points', () => {
    expect(applyBps(10000, 1650)).toBe(1650); // 16.5% of Rs 100
    expect(applyBps(630000, 250)).toBe(15750); // 2.5% commission on Rs 6,300
  });

  it('parses quantities without floating point', () => {
    expect(toMilli('2.5')).toBe(2500);
    expect(toMilli('0.001')).toBe(1);
    expect(toMilli('12')).toBe(12000);
    expect(toMilli('1.2300')).toBe(1230);
    expect(() => toMilli('1.2345')).toThrow();
    expect(() => toMilli('abc')).toThrow();
    expect(fromMilli(2500)).toBe('2.500');
    expect(fromMilli(-1)).toBe('-0.001');
  });

  it('splits profit so the parts always add back to the total', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    expect(allocate(630000, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(630000);
    expect(allocate(1001, [33.33, 33.33, 33.34]).reduce((a, b) => a + b, 0)).toBe(1001);
    expect(allocate(1000, [2, 1, 1])).toEqual([500, 250, 250]);
    for (const total of [1, 7, 99, 12345, 9_999_999]) {
      expect(allocate(total, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
});

describe('units and conversions', () => {
  it('converts purchase units to base units exactly', () => {
    expect(toBaseMilli('20', 'kg', 'mass')).toBe(20_000_000); // 20 kg = 20,000 g
    expect(toBaseMilli('1.5', 'l', 'volume')).toBe(1_500_000); // 1.5 L = 1,500 ml
    expect(toBaseMilli('250', 'g', 'mass')).toBe(250_000);
    expect(toBaseMilli('2', 'dozen', 'count')).toBe(24_000);
    expect(toBaseMilli('1', 'maund', 'mass')).toBe(40_000_000);
    expect(toBaseMilli('500', 'mg', 'mass')).toBe(500);
    expect(fromBaseMilli(2_500_000, 'kg')).toBe(2_500); // 2.5 kg
  });

  it('refuses to mix mass, volume and count', () => {
    expect(() => toBaseMilli('1', 'l', 'mass')).toThrow(/measures volume/);
    expect(() => toBaseMilli('1', 'kg', 'count')).toThrow();
    expect(() => toBaseMilli('1', 'cup', 'volume')).toThrow(/Unknown unit/);
  });
});

describe('sale totals and taxes', () => {
  const gst = { name: 'GST', rate_bps: 1650, applies_to: 'all' as const, inclusive: false };
  const fee = { name: 'Card fee', rate_bps: 500, applies_to: 'card' as const, inclusive: false };
  const incl = { name: 'GST incl', rate_bps: 1600, applies_to: 'all' as const, inclusive: true };

  it('no taxes: total is the item total', () => {
    expect(computeTotals(30000, [], 'cash')).toMatchObject({ subtotalMinor: 30000, taxMinor: 0, totalMinor: 30000 });
  });

  it('exclusive tax is added on top', () => {
    expect(computeTotals(10000, [gst], 'cash')).toMatchObject({ taxMinor: 1650, totalMinor: 11650 });
  });

  it('card fee only applies to non-cash payments', () => {
    expect(computeTotals(10000, [fee], 'cash').taxMinor).toBe(0);
    expect(computeTotals(10000, [fee], 'easypaisa')).toMatchObject({ taxMinor: 500, totalMinor: 10500 });
  });

  it('inclusive tax is carved out of the price, not added', () => {
    const t = computeTotals(11600, [incl], 'cash');
    expect(t.totalMinor).toBe(11600);
    expect(t.taxMinor).toBe(1600);
  });
});
