// The parts of the Workers D1 and R2 bindings that hosted results storage uses. These are local extensions of the
// minimal shapes in server/runtime/hosted/bindings.ts (which the coordinator owns): storage needs `head`, ranged and
// conditional `get`, and `put` with a SHA-256 the platform checks. `cloudBindings()` checks each shape, so a missing or
// misnamed binding is a typed refusal, never an exception deep in a read.
export type D1Value = string | number | null;
export interface CloudD1Statement {
  bind(...values: D1Value[]): CloudD1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface CloudD1 {
  prepare(sql: string): CloudD1Statement;
  /** One transaction: every statement or none. */
  batch(statements: CloudD1Statement[]): Promise<unknown[]>;
}
export interface CloudR2Head {
  key: string;
  size: number;
  etag: string;
  version: string;
  checksums: { sha256?: ArrayBuffer };
}
export interface CloudR2Body extends CloudR2Head { arrayBuffer(): Promise<ArrayBuffer> }
export interface CloudR2 {
  head(key: string): Promise<CloudR2Head | null>;
  get(key: string): Promise<CloudR2Body | null>;
  /**
   * R2 refuses the write when the bytes do not hash to `sha256` (hex). With `onlyIf.etagDoesNotMatch: '*'` the write
   * happens only when no object is under `key`, and the result is null when one is (R2's conditional put; its
   * behaviour on the real service is not exercised by the unit doubles).
   */
  put(key: string, value: Uint8Array, options: { sha256: string; onlyIf?: { etagDoesNotMatch: '*' } }): Promise<CloudR2Head | null>;
  /** Removes an object; an absent key is not an error (R2's `delete`). Present on the real bucket; only the staged-object sweep calls it. */
  delete?(key: string): Promise<void>;
  /**
   * Keys under `prefix` after `startAfter`, in key order, at most `limit` (R2's `list`, which caps a page at 1,000). Present on the real
   * bucket; only the staged-object sweep calls it.
   */
  list?(options: { prefix: string; startAfter?: string; limit: number }): Promise<{ objects: { key: string }[]; truncated: boolean }>;
}
export interface CloudBindings { db: CloudD1; bucket: CloudR2 }

const has = (value: unknown, ...methods: string[]) =>
  typeof value === 'object' && value !== null && methods.every((m) => typeof (value as Record<string, unknown>)[m] === 'function');

/** The storage bindings from a Workers env, or null when either is missing or has the wrong shape. */
export function cloudBindings(env: Readonly<Record<string, unknown>>): CloudBindings | null {
  return has(env.DB, 'prepare', 'batch') && has(env.BUCKET, 'head', 'get', 'put') ? { db: env.DB as CloudD1, bucket: env.BUCKET as CloudR2 } : null;
}
