import type { Versioned, WorkRegisterRow } from '$lib/server/runtime/contracts';

/** The local pure mergers consume register order and a legacy non-null fingerprint, not an unanchored hosted anchor. */
export function registerRows(rows: readonly Versioned<WorkRegisterRow>[]) {
  const seq = (r: WorkRegisterRow) => typeof r.fields.seq === 'number' && Number.isFinite(r.fields.seq) ? r.fields.seq : Number.MAX_SAFE_INTEGER;
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return [...rows].sort((a, b) => seq(a) - seq(b) || compare(a.createdAt, b.createdAt) || compare(a.rowId, b.rowId))
    .map((r) => ({ ...r, anchor: r.anchor?.sha256 ? { ...r.anchor, sha256: r.anchor.sha256 } : null }));
}
