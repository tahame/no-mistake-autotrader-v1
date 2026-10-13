import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

export const id = z.uuid();
export const orgParams = z.object({ orgId: id });
export const orgIdParams = z.object({ orgId: id, id });
/** Money in minor units (paisa); the app converts rupees x 100. */
export const minor = z.number().int().min(0).max(1e13);
export const positiveMinor = z.number().int().positive().max(1e13);
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
/** Quantities travel as decimal strings to avoid floating point. */
export const qty = z.union([z.string(), z.number()]).transform((v) => String(v)).pipe(z.string().regex(/^\d+(\.\d{1,3})?$/, 'Up to 3 decimals'));
export const range = z.object({ from: date, to: date, locationId: id.optional() });

export const typed = (app: FastifyInstance) => app.withTypeProvider<ZodTypeProvider>();
