import { HEADS_FIELDS, evidenceTokens, type HeadsValues } from '$lib/views/litigation/heads';
import { deleteValue } from '$lib/views/litigation/crossexam';
import type { Versioned, WorkRegisterRow } from '$lib/server/runtime/contracts';

export interface HeadsShard {
  caption: string | null;
  exportName: { name: string; note: string | null };
  known: string[];
}

export function headsMerge(shard: HeadsShard, rows: readonly Versioned<WorkRegisterRow>[], addId: string) {
  const known = new Set(shard.known);
  return {
    rows: rows.map((r) => {
      const values = Object.fromEntries(HEADS_FIELDS.map((k) => [k, r.fields[k] == null ? '' : String(r.fields[k])])) as HeadsValues;
      return { rowId: r.rowId, del: deleteValue(r.rowId, r.version), ...values, evidence: evidenceTokens(values.ref, (ref) => known.has(ref)) };
    }),
    caption: shard.caption, exportName: shard.exportName, addId,
  };
}
