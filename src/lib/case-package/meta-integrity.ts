// The META integrity check of the hosted sign-off gate (ADR 0012). The canonical validator only warns about a count
// disagreement and skips a count it has nothing to compare with, so this check never reads absence of a diagnostic as
// verification: it derives every count itself from the records and compares it with the carried value.
import type { TSchema } from 'typebox';
import Value from 'typebox/value';
import { INTEGRITY_DATASETS } from './registry.ts';
import { V5Chronology, V5People } from './records.ts';
import type { DatasetEnvelope } from './schema.ts';
import { isObject } from './strict-json.ts';

type Env = Readonly<DatasetEnvelope>;

export const META_SOURCE_PATH = 'META';

/** Whether a dataset is, or claims to be, the source's META root: under the integrity key, or at META's source path. */
export const carriesMeta = (e: Env): boolean => e.key === INTEGRITY_DATASETS.meta.key || e.provenance.sourcePath === META_SOURCE_PATH;

const only = (datasets: readonly Env[], key: string, sourcePath: string, schema: string, data: TSchema): Env | null => {
  const at = datasets.filter((e) => e.key === key || e.provenance.sourcePath === sourcePath);
  const e = at.length === 1 ? at[0]! : undefined;
  return e && e.key === key && e.provenance.sourcePath === sourcePath && e.schema === schema && Value.Check(data, e.data) ? e : null;
};

/**
 * Whether the one META dataset holds exactly the counts its records give: the document, text status, e-mail, invoice
 * and people totals and every bundle and document-type tally, each present and equal. A source with no people dataset
 * and no people carried in another form has zero people; people carried in a form that cannot be counted are not zero,
 * so their total cannot be verified. Any carrier of META or of a record set that is not the exact registered one fails.
 */
export function metaReconciles(datasets: readonly Env[]): boolean {
  if (datasets.filter(carriesMeta).length !== 1) return false;
  const meta = only(datasets, INTEGRITY_DATASETS.meta.key, META_SOURCE_PATH, INTEGRITY_DATASETS.meta.schema, INTEGRITY_DATASETS.meta.data);
  const chron = only(datasets, 'chronology', 'DATA.chronology', 'v5.chronology@1', V5Chronology);
  if (!meta || !chron || !isObject(meta.data) || !Array.isArray(chron.data)) return false;
  const carriesPeople = datasets.filter((e) => e.key === 'people' || e.provenance.sourcePath === 'DATA.people');
  const people = carriesPeople.length === 0 ? [] : only(datasets, 'people', 'DATA.people', 'v5.people@1', V5People)?.data;
  if (!Array.isArray(people)) return false;
  const M = meta.data;
  const rows = chron.data.filter(isObject);
  const tally = (field: string) => { const t = new Map<string, number>(); for (const r of rows) { const v = r[field] as string; t.set(v, (t.get(v) ?? 0) + 1); } return t; };
  const status = tally('text_status'), types = tally('doc_type'), bundles = tally('bundle');
  const same = (carried: unknown, n: number) => typeof carried === 'number' && carried === n;
  if (!(same(M.docCount, rows.length) && same(M.textNone, status.get('none') ?? 0) && same(M.textPending, status.get('pending') ?? 0)
    && same(M.emails, types.get('email') ?? 0) && same(M.invoices, types.get('invoice') ?? 0) && same(M.people, people.length))) return false;
  return ([['bundles', bundles], ['docTypes', types]] as const).every(([group, counts]) => {
    const held = M[group];
    return isObject(held) && [...new Set([...Object.keys(held), ...counts.keys()])].every((k) => same(Object.hasOwn(held, k) ? held[k] : undefined, counts.get(k) ?? 0));
  });
}
