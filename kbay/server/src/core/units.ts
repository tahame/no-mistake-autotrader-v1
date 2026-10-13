import { badRequest } from './errors.js';
import { mulDiv, toMilli } from './math.js';

// Units and conversions — handled in one place so every cost number is consistent.
// Mirrors catalog.units. factorMicro = base units per one of this unit, times 1,000,000.
export const UNITS = {
  mg: { name: 'milligram', dimension: 'mass', factorMicro: 1_000 },
  g: { name: 'gram', dimension: 'mass', factorMicro: 1_000_000 },
  kg: { name: 'kilogram', dimension: 'mass', factorMicro: 1_000_000_000 },
  maund: { name: 'maund (40 kg)', dimension: 'mass', factorMicro: 40_000_000_000 },
  ml: { name: 'millilitre', dimension: 'volume', factorMicro: 1_000_000 },
  l: { name: 'litre', dimension: 'volume', factorMicro: 1_000_000_000 },
  unit: { name: 'unit', dimension: 'count', factorMicro: 1_000_000 },
  dozen: { name: 'dozen', dimension: 'count', factorMicro: 12_000_000 },
} as const;

export type UnitCode = keyof typeof UNITS;
export type Dimension = 'mass' | 'volume' | 'count';
export const BASE_UNIT: Record<Dimension, UnitCode> = { mass: 'g', volume: 'ml', count: 'unit' };

export function isUnit(u: string): u is UnitCode {
  return u in UNITS;
}

/** Convert a quantity in any unit to integer milli-base-units (e.g. "2.5" kg -> 2,500,000 milli-g). */
export function toBaseMilli(qty: string | number, unit: string, dimension: Dimension): number {
  if (!isUnit(unit)) throw badRequest('bad_unit', `Unknown unit ${unit}`);
  const u = UNITS[unit];
  if (u.dimension !== dimension) {
    throw badRequest('unit_mismatch', `${unit} measures ${u.dimension}, but this item is measured by ${dimension}.`);
  }
  return mulDiv(toMilli(qty), u.factorMicro, 1_000_000);
}

/** Convert integer milli-base-units back into a display unit, as milli of that unit. */
export function fromBaseMilli(baseMilli: number, unit: UnitCode): number {
  return mulDiv(baseMilli, 1_000_000, UNITS[unit].factorMicro);
}
