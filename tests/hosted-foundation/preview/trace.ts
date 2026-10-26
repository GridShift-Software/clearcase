// Test instrumentation: every D1 statement and Web Crypto digest a request makes, in order, with a way to act as a
// concurrent actor at an exact step (after a statement's answer, or as a digest starts), as a lost grant or session would.
import { vi } from 'vitest';
import type { CloudD1Statement } from '../../../src/lib/storage/cloud/bindings.ts';

const REAL_DIGEST = crypto.subtle.digest.bind(crypto.subtle);

export interface Op { kind: 'd1' | 'digest'; sql: string; binds: unknown[] }
type Step = (op: Op) => boolean;
type Db = { prepare(sql: string): CloudD1Statement; batch(ss: CloudD1Statement[]): Promise<unknown[]> };

export const d1 = (starts: string): Step => (op) => op.kind === 'd1' && op.sql.trimStart().startsWith(starts);
export const d1Has = (text: string): Step => (op) => op.kind === 'd1' && op.sql.includes(text);
export const digest: Step = (op) => op.kind === 'digest';
export const audited = (action: string): Step => (op) => op.kind === 'd1' && /^\s*INSERT INTO native_audit_events/.test(op.sql) && op.binds.some((b) => typeof b === 'string' && b.includes(`"${action}"`));

export function trace(target: object) {
  const db = target as unknown as Db, log: Op[] = [];
  const prepare = db.prepare.bind(db), batch = db.batch.bind(db);
  const watches: { steps: Step[]; at: number; act: (op: Op) => void | Promise<void> }[] = [];
  async function emit(op: Op) {
    log.push(op);
    for (const w of watches) if (w.at < w.steps.length && w.steps[w.at]!(op)) { w.at++; if (w.at === w.steps.length) await w.act(op); }
  }
  const raw = new WeakMap<object, CloudD1Statement>();
  const wrap = (s: CloudD1Statement, sql: string, binds: unknown[]): CloudD1Statement => {
    const w: CloudD1Statement = {
      bind: (...v) => wrap(s.bind(...v), sql, v),
      first: async <T>() => { const r = await s.first<T>(); await emit({ kind: 'd1', sql, binds }); return r; },
      all: async <T>() => { const r = await s.all<T>(); await emit({ kind: 'd1', sql, binds }); return r; },
      run: async () => { const r = await s.run(); await emit({ kind: 'd1', sql, binds }); return r; },
    };
    raw.set(w, s);
    return w;
  };
  db.prepare = (sql) => wrap(prepare(sql), sql, []);
  db.batch = async (ss) => { const r = await batch(ss.map((s) => raw.get(s) ?? s)); await emit({ kind: 'd1', sql: 'BATCH', binds: [] }); return r; };
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...a: Parameters<typeof REAL_DIGEST>) => { await emit({ kind: 'digest', sql: '', binds: [] }); return REAL_DIGEST(...a); });
  return {
    log,
    /** Runs `act` once, when the ops named in `steps` have occurred in that order. A d1 step acts right after its answer. */
    when(steps: Step[], act: (op: Op) => void | Promise<void>) { watches.push({ steps, at: 0, act }); },
    /** Index of the last op satisfying `step`, or -1. */
    last(step: Step) { for (let i = log.length - 1; i >= 0; i--) if (step(log[i]!)) return i; return -1; },
  };
}

/** The operate grant is read in SQL by every fence statement: the last such statement is the release fence. */
export const fenceStep: Step = (op) => op.kind === 'd1' && op.sql.includes('tenant_case_grants');
