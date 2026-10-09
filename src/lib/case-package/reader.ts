// Read model over a Candidate: typed datasets, per-document state, attachment routes,
// counts derived from validated records next to the raw source META, and seed rows with
// stable ids. Lookups use Maps keyed by untrusted strings (no prototype exposure).
// Hrefs are never taken from data; the app builds routes (see render.ts documentRoute).
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.ts';
import type { Candidate } from './candidate.ts';
import { serveModeOf, type ServeMode, type TextStatus } from './media.ts';
import type { OriginalMapping } from './originals.ts';
import type { Static } from 'typebox';
import type * as R from './records.ts';
import { KNOWN_SCHEMAS, SEED_DATASETS } from './registry.ts';
import type { Asset } from './schema.ts';
import type { SeedRow } from './user-work.ts';
import { seedRows, textOf } from './validate.ts';

export type ChronologyRow = Static<typeof R.V5Chronology>[number];

export interface DocumentState {
  ref: string;
  /** present: verified bytes; missing: indexed but not available; blocked: no usable mapping */
  file: 'present' | 'missing' | 'blocked';
  /** how the originals server may show it; 'none' when there are no bytes */
  preview: ServeMode | 'none';
  text: TextStatus | 'unknown';
  mediaType: string | null;
  original: Readonly<OriginalMapping> | null;
  /** visible flags: missing-original, case-mismatch, download-only */
  flags: string[];
}

export interface AttachmentView { key: string; parentRef: string; member: string | null; ordinal: number | null; mediaType: string; kind: Asset['kind'] }

export type AttachmentRoute =
  | { route: 'parent'; key: string; parentRef: string; member: string; original: Readonly<OriginalMapping> } // open the container, show the member
  | { route: 'direct'; key: string; parentRef: string; original: Readonly<OriginalMapping> } // extracted attachment with its own bytes
  | { route: 'unavailable'; key: string; parentRef: string; reason: 'parent-missing' | 'original-missing' | 'unknown-parent' };

export interface DerivedCounts {
  documents: number;
  byBundle: Record<string, number>;
  byTextStatus: Record<string, number>;
  byDocType: Record<string, number>;
  emails: number;
  invoices: number;
  people: number | null;
  attachments: number;
}

/** Counts keyed by untrusted values: a Map, returned as an object whose keys are all own properties. */
const tally = (rows: readonly ChronologyRow[], f: keyof ChronologyRow): Record<string, number> => {
  const out = new Map<string, number>();
  for (const r of rows) { const k = textOf(r[f]); out.set(k, (out.get(k) ?? 0) + 1); }
  return Object.fromEntries([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
};

export function readCandidate(candidate: Candidate) {
  /** typed access to recognized datasets only; an unknown or opaque dataset is never handed to views */
  const data = <T = unknown>(key: string): T | null => { const e = candidate.dataset(key); return e && KNOWN_SCHEMAS.has(e.schema) ? (e.data as T) : null; };
  const rows = (data<ChronologyRow[]>('chronology') ?? []) as readonly ChronologyRow[];
  const byRef = new Map(rows.map((r) => [r.ref, r]));
  const assets = new Map(Object.entries(candidate.assets));
  const children = new Map<string, string[]>();
  for (const [k, a] of assets) if (a.parentRef !== undefined) children.set(a.parentRef, [...(children.get(a.parentRef) ?? []), k]);

  const documentState = (ref: string): DocumentState | null => {
    const row = byRef.get(ref);
    const a = assets.get(ref);
    if (!row && !a) return null;
    const ts = row?.text_status;
    const text: DocumentState['text'] = a?.textStatus ?? (ts === 'extracted' || ts === 'ocr' || ts === 'none' || ts === 'pending' ? ts : 'unknown');
    const original = candidate.original(ref);
    if (original) {
      const flags = [...(original.status === 'case-mismatch' ? ['case-mismatch'] : []), ...(original.downloadOnly ? ['download-only'] : [])];
      return { ref, file: 'present', preview: original.downloadOnly ? 'download' : serveModeOf(original.mediaType), text, mediaType: original.mediaType, original, flags };
    }
    if (!a) return { ref, file: 'blocked', preview: 'none', text, mediaType: null, original: null, flags: ['not-indexed'] };
    if (a.kind === 'embedded') return { ref, file: 'blocked', preview: 'none', text, mediaType: a.mediaType, original: null, flags: ['embedded'] };
    return { ref, file: 'missing', preview: 'none', text, mediaType: a.mediaType, original: null, flags: ['missing-original'] };
  };

  const attachmentsOf = (parentRef: string): AttachmentView[] =>
    (children.get(parentRef) ?? []).map((key) => {
      const a = assets.get(key)!;
      return { key, parentRef, member: a.kind === 'embedded' ? a.member : null, ordinal: a.kind === 'embedded' ? a.ordinal : null, mediaType: a.mediaType, kind: a.kind };
    }).sort((x, y) => (x.ordinal ?? 0) - (y.ordinal ?? 0) || (x.key < y.key ? -1 : 1));

  const resolveAttachment = (key: string): AttachmentRoute | null => {
    const a = assets.get(key);
    if (!a || a.parentRef === undefined) return null;
    const parentRef = a.parentRef;
    if (a.kind === 'file') {
      const own = candidate.original(key);
      return own ? { route: 'direct', key, parentRef, original: own } : { route: 'unavailable', key, parentRef, reason: 'original-missing' };
    }
    if (a.kind === 'missing') return { route: 'unavailable', key, parentRef, reason: 'original-missing' };
    // embedded: walk up to the first container that has verified bytes
    let cur: string | undefined = parentRef;
    for (let d = 0; cur !== undefined && d <= 4; d++) {
      const p = assets.get(cur);
      if (!p) return { route: 'unavailable', key, parentRef, reason: 'unknown-parent' };
      if (p.kind !== 'embedded') {
        const o = candidate.original(cur);
        return o ? { route: 'parent', key, parentRef, member: a.member, original: o } : { route: 'unavailable', key, parentRef, reason: 'parent-missing' };
      }
      cur = p.parentRef;
    }
    return { route: 'unavailable', key, parentRef, reason: 'unknown-parent' };
  };

  const derivedCounts = (): DerivedCounts => {
    const types = tally(rows, 'doc_type');
    const people = data<unknown[]>('people');
    return {
      documents: rows.length,
      byBundle: tally(rows, 'bundle'),
      byTextStatus: tally(rows, 'text_status'),
      byDocType: types,
      emails: Object.hasOwn(types, 'email') ? types.email! : 0,
      invoices: Object.hasOwn(types, 'invoice') ? types.invoice! : 0,
      people: Array.isArray(people) ? people.length : null,
      attachments: [...assets.values()].filter((x) => x.parentRef !== undefined).length,
    };
  };

  const seeds = (): SeedRow[] => {
    const out: SeedRow[] = [];
    for (const [datasetKey, def] of Object.entries(SEED_DATASETS)) {
      const env = candidate.dataset(datasetKey);
      if (!env) continue;
      for (const record of seedRows(env.data, def.pointer)) {
        const natural = Object.fromEntries(def.keyFields.map((f) => [f, record[f] ?? null]));
        const seedId = 'seed:' + createHash('sha256').update(canonicalJson({ dataset: datasetKey, key: natural })).digest('hex').slice(0, 32);
        const seedSha256 = createHash('sha256').update(canonicalJson(record)).digest('hex');
        out.push({ datasetKey, seedId, seedSha256, record });
      }
    }
    return out;
  };

  return {
    caseId: candidate.caseId,
    resultsVersion: candidate.resultsVersion,
    /** typed access to recognized datasets; null for unknown or opaque ones (use candidate.dataset() for the stored envelope) */
    dataset: data,
    chronology: rows,
    /** raw source META, never corrected; display derivedCounts() instead */
    sourceMeta: data<Static<typeof R.V5Meta>>('meta'),
    documentState,
    attachmentsOf,
    resolveAttachment,
    derivedCounts,
    seeds,
    /** fingerprint-based identity for anchors: every verified original */
    originals: (): { ref: string; sha256: string }[] => candidate.originalRefs().map((ref) => ({ ref, sha256: candidate.original(ref)!.sha256 })),
  };
}

export type CandidateReader = ReturnType<typeof readCandidate>;
