import { contractError } from '../../server/runtime/errors.ts';
import type { CloudD1, CloudD1Statement, D1Value } from './bindings.ts';

/**
 * The first statement of a guarded batch: when `condition` does not hold, it inserts NULL into `rs_batch_guard`, whose
 * NOT NULL constraint fails the statement and so rolls the whole batch back. Every write that depends on a state read
 * earlier rechecks that state here, inside its own transaction.
 */
export const guard = (db: CloudD1, condition: string, ...values: D1Value[]): CloudD1Statement =>
  db.prepare(`INSERT INTO rs_batch_guard (token) SELECT NULL WHERE NOT (${condition})`).bind(...values);

/** A D1 failure as the contract's retryable refusal. */
export const failClosed = <C extends string>(code: C) => (): never => { throw contractError(code, true); };

export const isConstraintFailure = (e: unknown) => e instanceof Error && /constraint|NOT NULL/i.test(e.message);
