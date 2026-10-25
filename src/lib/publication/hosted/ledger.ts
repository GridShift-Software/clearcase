import type { PublicationLedger } from './ports.ts';

// RED skeleton: a ledger that records nothing.
export type PublicationD1Value = string | number | null;
export interface PublicationD1Statement {
  bind(...values: PublicationD1Value[]): PublicationD1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface PublicationD1 { prepare(sql: string): PublicationD1Statement; batch(statements: PublicationD1Statement[]): Promise<unknown[]> }

export function d1PublicationLedger(_db: PublicationD1): PublicationLedger {
  return {
    recordSignoff: async (record) => ({ kind: 'recorded', record, repeated: false }),
    signoff: async () => null,
    settleSignoff: async () => {},
    invalidateSignoff: async () => {},
    beginOperation: async (record) => ({ kind: 'begun', record, repeated: false }),
    finishOperation: async () => {},
    settleOperation: async () => {},
  };
}
