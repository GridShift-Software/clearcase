import type { ContractError } from './contracts.ts';
export function contractError<C extends string>(code: C, retryable = false): ContractError<C> {
  return Object.assign(new Error(code), { code, retryable });
}
export const rejectUnavailable = <C extends string>(code: C) => async (): Promise<never> => { throw contractError(code, true); };
const DENIALS = new Set(['unauthenticated', 'invalid-session', 'wrong-client', 'forbidden']);
/** An authority refusal (as opposed to a fault): every one appends a scoped denial event. */
export const isDenial = (e: unknown) => e instanceof Error && 'code' in e && typeof e.code === 'string' && DENIALS.has(e.code);
export const codeOf = (e: unknown) => e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : null;
