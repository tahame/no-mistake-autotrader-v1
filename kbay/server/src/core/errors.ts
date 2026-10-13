export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details);
export const unauthorized = (message = 'Please sign in') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do this') => new AppError(403, 'forbidden', message);
export const notFound = (what = 'Record') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);

/** Map database invariant violations (raised by triggers/constraints) to clear API errors. */
export function fromDbError(err: unknown): AppError | undefined {
  const e = err as { code?: string; message?: string; constraint_name?: string };
  if (!e || typeof e !== 'object' || !e.code) return undefined;
  const msg = e.message ?? '';
  if (e.code === 'P0001') {
    if (msg.startsWith('day_locked')) return conflict('day_locked', 'That business day is approved and locked.');
    if (msg.startsWith('immutable_record')) return conflict('immutable_record', 'Posted records cannot be changed; record a correction instead.');
    if (msg.startsWith('unbalanced_journal_entry')) return new AppError(500, 'unbalanced_entry', 'Internal accounting error: entry did not balance.');
    return conflict('rule_violation', msg);
  }
  if (e.code === '23505') return conflict('duplicate', 'That already exists.', { constraint: e.constraint_name });
  if (e.code === '23503') return badRequest('invalid_reference', 'A referenced record does not exist.', { constraint: e.constraint_name });
  if (e.code === '23514') return badRequest('check_failed', 'A value is not allowed.', { constraint: e.constraint_name });
  if (e.code === '22P02') return badRequest('invalid_value', 'A value has the wrong format.');
  return undefined;
}
