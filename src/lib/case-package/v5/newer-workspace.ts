// The newer builder of the v5 workspace HTML (META.version "V1", built from September 2026) writes the same
// `const DATA` and `const META` lines but changes several dataset shapes and adds datasets (profile, text, emails,
// whatsapp, organogram, transcripts, anchors). This module recognises that generation and maps its shapes onto the
// v5 datasets as pure functions: a field the v5 shape requires is filled from the record itself or from the chronology
// row of the same ref, never invented; a source field the v5 shape has no place for stays on its record (preserved,
// reported as an unsupported field, not rendered). A dataset left unmapped and failing its schema is demoted to an
// opaque residual by the adapter (V5_DATASET_SHAPE_UNMAPPED), never rejected.
import { isObject, type JsonObject, type JsonValue } from '../strict-json.ts';
import type { V5Root } from './extract.ts';

type Roots = Partial<Record<V5Root, JsonValue>>;
type RowsByRef = ReadonlyMap<string, JsonObject>;

const str = (v: JsonValue | undefined): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const num = (v: JsonValue | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const count = (v: JsonValue | undefined): number => Math.max(0, Math.trunc(num(v)));
const objs = (v: JsonValue | undefined): JsonObject[] => (Array.isArray(v) ? v.filter(isObject) : []);
const nonEmpty = (parts: string[]) => parts.filter((s) => s !== '');
const tally = (keys: Iterable<string>): Record<string, number> => { const c: Record<string, number> = {}; for (const k of keys) c[k] = (c[k] ?? 0) + 1; return c; };
/** Every object of a list mapped; anything else in the list, or a non-list, is carried over as written. */
const mapObjs = (v: JsonValue | undefined, f: (o: JsonObject) => JsonObject): JsonValue | undefined => (Array.isArray(v) ? v.map((x) => (isObject(x) ? f(x) : x)) : v);

/** The newer builder stamps META.version and META.fileCount and writes a DATA.profile; v5 has none of them. */
export function isNewerGeneration(DATA: JsonObject, META: JsonObject): boolean {
  return typeof META.version === 'string' || typeof META.fileCount === 'number' || isObject(DATA.profile);
}

/** v5 META: the invoice count, date span and document-type tallies come from the rows when the source has none. */
export function metaOf(meta: JsonObject, rows: readonly JsonObject[]): JsonObject {
  const types = tally(rows.map((r) => str(r.doc_type)));
  const dates = rows.map((r) => str(r.date)).filter((d) => d !== '').sort();
  return {
    ...meta,
    invoices: meta.invoices ?? types.invoice ?? 0,
    dateSpan: meta.dateSpan ?? (dates.length ? [dates[0]!, dates[dates.length - 1]!] : []),
    docTypes: meta.docTypes ?? types,
  };
}

/** A profile value as narrative text: a list one item per line, an object one `key: value` per line. */
function narrative(v: JsonValue | undefined): string {
  if (Array.isArray(v)) return v.map((x) => (isObject(x) ? Object.entries(x).map(([k, y]) => `${k}: ${narrative(y)}`).join(', ') : narrative(x))).join('\n');
  if (isObject(v)) return Object.entries(v).map(([k, y]) => `${k}: ${narrative(y)}`).join('\n');
  return str(v);
}

/** The profile fields read as the matter narrative, in page order, under a plain heading each. */
const PROFILE_HEADINGS: readonly [key: string, heading: string, section: 'storyline' | 'strategy'][] = [
  ['claim_type', 'The claim', 'storyline'],
  ['forum', 'Forum', 'storyline'],
  ['headline_note', 'Amount owing', 'storyline'],
  ['quantum_chain', 'Quantum chain', 'storyline'],
  ['discovery_affidavits', 'Discovery affidavits', 'storyline'],
  ['prescription', 'Prescription', 'storyline'],
  ['notes', 'Notes', 'storyline'],
  ['existential_risk', 'Existential risk', 'strategy'],
  ['strategy_inputs', 'Strategy inputs', 'strategy'],
  ['interest_basis', 'Interest basis', 'strategy'],
  ['trial_bundle_plan', 'Trial bundle plan', 'strategy'],
  ['out_of_scope', 'Out of scope', 'strategy'],
];

/** The v5 matter from the newer profile: the parties first, then each narrative field under its heading. */
export function matterOf(profile: JsonObject, meta: JsonObject): JsonObject {
  const parties = nonEmpty([
    nonEmpty([str(profile.we_act_for), str(profile.our_role) && `(${str(profile.our_role)})`]).join(' '),
    nonEmpty([str(profile.opponent), str(profile.opponent_type) && `(${str(profile.opponent_type)})`]).join(' '),
  ]).join('\n');
  const storyline: JsonObject[] = parties ? [{ h: 'Parties', t: parties }] : [];
  const strategy: JsonObject[] = [];
  for (const [key, h, section] of PROFILE_HEADINGS) {
    const t = narrative(profile[key]);
    if (t !== '') (section === 'storyline' ? storyline : strategy).push({ h, t });
  }
  const title = str(profile.matter_full) || str(meta.matter);
  return { title, short: str(profile.short) || str(meta.short) || title, forum: str(profile.forum), storyline, strategy };
}

/** A series or sample row with the v5 `filename`: the chronology row's, else the record's own title. */
const withFilename = (rowsByRef: RowsByRef) => (r: JsonObject): JsonObject =>
  typeof r.filename === 'string' ? r : { ...r, filename: str(rowsByRef.get(str(r.ref))?.filename) || str(r.title) };

/** v5 quantum: the three series carry a filename per row. */
export function quantumOf(q: JsonObject, rowsByRef: RowsByRef): JsonObject {
  const fill = withFilename(rowsByRef);
  const out: JsonObject = { ...q };
  for (const k of ['amountDueSeries', 'statementSeries', 'interestSeries']) if (q[k] !== undefined) out[k] = mapObjs(q[k], fill)!;
  return out;
}

const hasMatter = (v: JsonValue | undefined): boolean => isObject(v) && typeof v.title === 'string';

/** The newer roots in the v5 shapes, as far as they are mapped; every other value is carried over as written. */
export function mapNewerRoots(roots: Roots): Roots {
  if (!isObject(roots.DATA) || !isObject(roots.META)) return roots;
  const DATA = roots.DATA, META = roots.META;
  const rows = objs(DATA.chronology);
  const rowsByRef: RowsByRef = new Map(rows.map((r) => [str(r.ref), r]));
  const out: JsonObject = { ...DATA };
  if (isObject(DATA.profile) && !hasMatter(DATA.matter)) out.matter = matterOf(DATA.profile, META);
  if (isObject(DATA.quantum)) out.quantum = quantumOf(DATA.quantum, rowsByRef);
  return { ...roots, DATA: out, META: metaOf(META, rows) };
}
