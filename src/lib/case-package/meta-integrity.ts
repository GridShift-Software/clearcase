// The META integrity check of the hosted sign-off gate (ADR 0012). The canonical validator only warns about a count
// disagreement and skips a count it has nothing to compare with, so this check never reads absence of a diagnostic as
// verification: it derives every count itself from the records and compares it with the carried value.
import type { TSchema } from 'typebox';
import Value from 'typebox/value';
import { INTEGRITY_DATASETS } from './registry.ts';
import { V5Chronology, V5People } from './records.ts';
import type { DatasetEnvelope } from './schema.ts';
import { escapePointer, isObject } from './strict-json.ts';
import { canonicalJson } from './canonical.ts';
import { fingerprint } from './diagnostics.ts';
import { sha256Hex } from './hash.ts';

type Env = Readonly<DatasetEnvelope>;

export const META_SOURCE_PATH = 'META';

/** Whether a dataset is, or claims to be, the source's META root: under the integrity key, or at META's source path. */
export const carriesMeta = (e: Env): boolean => e.key === INTEGRITY_DATASETS.meta.key || e.provenance.sourcePath === META_SOURCE_PATH;

const only = (datasets: readonly Env[], key: string, sourcePath: string, schema: string, data: TSchema): Env | null => {
  const at = datasets.filter((e) => e.key === key || e.provenance.sourcePath === sourcePath);
  const e = at.length === 1 ? at[0]! : undefined;
  return e && e.key === key && e.provenance.sourcePath === sourcePath && e.schema === schema && Value.Check(data, e.data) ? e : null;
};

type Group = 'bundles' | 'docTypes';
interface Count { readonly group: Group | null; readonly field: string; readonly derived: number; readonly carried: number | null }
type Derivation = { readonly ok: false } | { readonly ok: true; readonly differing: readonly Count[] };

/**
 * Every META count the records give, compared with the one META carries: the document, text status, e-mail, invoice and people
 * totals and every bundle and document-type tally. A source with no people dataset and no people carried in another form has
 * zero people; people carried in a form that cannot be counted are not zero, so their total cannot be verified. Any carrier of
 * META or of a record set that is not the exact registered one, and any count carried as something other than a number, cannot
 * be verified (`ok: false`). A tally key the records have and META lacks differs, carried as null. One pass over the records.
 */
function deriveMeta(datasets: readonly Env[]): Derivation {
  if (datasets.filter(carriesMeta).length !== 1) return { ok: false };
  const meta = only(datasets, INTEGRITY_DATASETS.meta.key, META_SOURCE_PATH, INTEGRITY_DATASETS.meta.schema, INTEGRITY_DATASETS.meta.data);
  const chron = only(datasets, 'chronology', 'DATA.chronology', 'v5.chronology@1', V5Chronology);
  if (!meta || !chron || !isObject(meta.data) || !Array.isArray(chron.data)) return { ok: false };
  const carriesPeople = datasets.filter((e) => e.key === 'people' || e.provenance.sourcePath === 'DATA.people');
  const people = carriesPeople.length === 0 ? [] : only(datasets, 'people', 'DATA.people', 'v5.people@1', V5People)?.data;
  if (!Array.isArray(people)) return { ok: false };
  const M = meta.data;
  const rows = chron.data.filter(isObject);
  const tally = (field: string) => { const t = new Map<string, number>(); for (const r of rows) { const v = r[field] as string; t.set(v, (t.get(v) ?? 0) + 1); } return t; };
  const status = tally('text_status'), types = tally('doc_type'), bundles = tally('bundle');
  const differing: Count[] = [];
  const compare = (group: Group | null, field: string, carried: unknown, derived: number): boolean => {
    if (carried === undefined && group !== null) differing.push({ group, field, derived, carried: null });
    else if (typeof carried !== 'number') return false;
    else if (carried !== derived) differing.push({ group, field, derived, carried });
    return true;
  };
  const scalars: [string, number][] = [['docCount', rows.length], ['textNone', status.get('none') ?? 0], ['textPending', status.get('pending') ?? 0],
    ['emails', types.get('email') ?? 0], ['invoices', types.get('invoice') ?? 0], ['people', people.length]];
  for (const [field, n] of scalars) if (!compare(null, field, M[field], n)) return { ok: false };
  for (const [group, counts] of [['bundles', bundles], ['docTypes', types]] as const) {
    const held = M[group];
    if (!isObject(held)) return { ok: false };
    for (const k of new Set([...Object.keys(held), ...counts.keys()])) if (!compare(group, k, Object.hasOwn(held, k) ? held[k] : undefined, counts.get(k) ?? 0)) return { ok: false };
  }
  return { ok: true, differing };
}

/**
 * Whether the one META dataset holds exactly the counts its records give: the document, text status, e-mail, invoice
 * and people totals and every bundle and document-type tally, each present and equal. A source with no people dataset
 * and no people carried in another form has zero people; people carried in a form that cannot be counted are not zero,
 * so their total cannot be verified. Any carrier of META or of a record set that is not the exact registered one fails.
 */
export function metaReconciles(datasets: readonly Env[]): boolean {
  const d = deriveMeta(datasets);
  return d.ok && d.differing.length === 0;
}

// ---- Snapshot v2: `disagrees` (ADR-0014, Proposed) --------------------------------------------------------------------------
// A legacy export's META can disagree with its records. The gate never trusts a list of disagreements the package claims: it derives
// them from the records (`deriveMeta`), and the section is `disagrees` only when that derivation is exactly what the validator also
// warned about. Each disagreement gets a fingerprint bound to the exact candidate, the exact validation and the two values, so a
// changed value, a re-validation or another candidate gives a new fingerprint and an old acknowledgement no longer matches it.

export const META_DISAGREEMENT_CODE = 'V5_META_COUNT_DISAGREEMENT';
/** A META with more differing counts than this is held as `invalid`, so the persisted derivation stays a bounded number of items. */
export const MAX_META_DISAGREEMENTS = 256;
const FINGERPRINT_TAG = 'clearcase.meta-count-disagreement/1';

/** The candidate and validation a disagreement is bound to. */
export interface MetaBinding { readonly resultsVersion: string; readonly manifestSha256: string; readonly validatorVersion: string; readonly diagnosticsSha256: string }
/** One count that differs: what META carries (null when it lacks the key) against what the records give. */
export interface MetaCountDetail { readonly diagnostic: string; readonly subject: string; readonly carried: number | null; readonly derived: number }
export interface MetaDisagreement extends MetaCountDetail { readonly fingerprint: string }

export const metaDisagreementFingerprint = (b: MetaBinding, d: MetaCountDetail): string =>
  sha256Hex(canonicalJson([FINGERPRINT_TAG, b.resultsVersion, b.manifestSha256, b.validatorVersion, b.diagnosticsSha256, d.diagnostic, d.subject, d.carried, d.derived])).slice(0, 32);

export type MetaSectionV2 =
  | { readonly state: 'integrity-verified' }
  | { readonly state: 'disagrees'; readonly disagreements: readonly MetaDisagreement[] }
  | { readonly state: 'invalid' };

/** The validator's own `V5_META_COUNT_DISAGREEMENT` instance for a count: the same file, pointer and subject `validate.ts` reports it at. */
function diagnosticOf(c: Count): { diagnostic: string; subject: string } {
  const subject = (c.group === null ? `META.${c.field}` : `META.${c.group}[${JSON.stringify(c.field)}]`).slice(0, 200);
  const pointer = '/data' + (c.group === null ? '' : `/${c.group}`) + '/' + escapePointer(c.field);
  return { diagnostic: fingerprint(META_DISAGREEMENT_CODE, { file: 'datasets/meta.json', pointer, subject }), subject };
}

/**
 * The state of the META section for a v2 snapshot, derived from the records. `warningFingerprints` are the validation's warning
 * fingerprints and `diagnostics` is how many `V5_META_COUNT_DISAGREEMENT` instances it reported. `disagrees` needs every difference
 * the gate finds to carry its own matching validator warning and the validator to have reported no other; a count that cannot be
 * verified, a difference with no matching warning, or a warning the records do not explain is `invalid`.
 */
export function metaSectionV2(datasets: readonly Env[], v: { binding: MetaBinding; warningFingerprints: Iterable<string>; diagnostics: number }): MetaSectionV2 {
  const d = deriveMeta(datasets);
  if (!d.ok) return { state: 'invalid' };
  if (d.differing.length === 0) return v.diagnostics === 0 ? { state: 'integrity-verified' } : { state: 'invalid' };
  if (d.differing.length > MAX_META_DISAGREEMENTS || v.diagnostics !== d.differing.length) return { state: 'invalid' };
  const warned = new Set(v.warningFingerprints), seen = new Set<string>();
  const disagreements: MetaDisagreement[] = [];
  for (const c of d.differing) {
    const { diagnostic, subject } = diagnosticOf(c);
    if (!warned.has(diagnostic) || seen.has(diagnostic)) return { state: 'invalid' };
    seen.add(diagnostic);
    const detail = { diagnostic, subject, carried: c.carried, derived: c.derived };
    disagreements.push({ ...detail, fingerprint: metaDisagreementFingerprint(v.binding, detail) });
  }
  disagreements.sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1));
  return { state: 'disagrees', disagreements };
}

/**
 * The evidence items the META section contributes, in ascending key order: its `section/meta` item and, when it disagrees, one
 * `warning/<fingerprint>` item per disagreement (the fingerprint a sign-off acknowledges), carrying the counts so the publisher can
 * be told which ones. Fixed vocabularies only; at most `MAX_META_DISAGREEMENTS + 1` items.
 */
export function metaEvidenceItems(section: MetaSectionV2): { key: string; observation: Record<string, unknown> }[] {
  const items: { key: string; observation: Record<string, unknown> }[] = [{ key: 'section/meta', observation: { kind: 'section', key: 'meta', state: section.state } }];
  if (section.state === 'disagrees') {
    for (const d of section.disagreements) items.push({ key: `warning/${d.fingerprint}`, observation: { kind: 'warning', fingerprint: d.fingerprint, meta: { diagnostic: d.diagnostic, subject: d.subject, carried: d.carried, derived: d.derived } } });
  }
  return items;
}
