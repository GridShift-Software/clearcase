import type { ContractError } from './contracts.ts';
export function contractError<C extends string>(code: C, retryable = false): ContractError<C> {
  return Object.assign(new Error(code), { code, retryable });
}
export const rejectUnavailable = <C extends string>(code: C) => async (): Promise<never> => { throw contractError(code, true); };
