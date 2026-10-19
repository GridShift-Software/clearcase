import type { DiagSink } from '../diagnostics.ts';
import { isObject, type JsonObject, type JsonValue } from '../strict-json.ts';
import type { V5Root } from './extract.ts';

type Roots = Partial<Record<V5Root, JsonValue>>;
type RowsByRef = ReadonlyMap<string, JsonObject>;

const str = (v: JsonValue | undefined): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const num = (v: JsonValue | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const count = (v: JsonValue | undefined): number => Math.max(0, Math.trunc(num(v)));
const objs = (v: JsonValue | undefined): JsonObject[] => (Array.isArray(v) ? v.filter(isObject) : []);
const nonEmpty = (parts: string[]) => parts.filter((s) => s !== '');
/** Sets an own property, as the strict parser does: a source key such as "__proto__" never swaps a prototype. */
const own = <T extends object>(o: T, k: string, v: unknown): T => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
const tally = (keys: Iterable<string>): Record<string, number> => { const c: Record<string, number> = {}; for (const k of keys) own(c, k, (Object.hasOwn(c, k) ? c[k]! : 0) + 1); return c; };
const mapObjs = (v: JsonValue | undefined, f: (o: JsonObject) => JsonObject): JsonValue | undefined => (Array.isArray(v) ? v.map((x) => (isObject(x) ? f(x) : x)) : v);

/** The builder versions this adapter maps. Another META.version is a generation nobody has inventoried. */
export const NEWER_VERSIONS: readonly string[] = ['V1'];

/** The newer builder stamps META.version and META.fileCount and writes a DATA.profile; v5 has none of them. */
export function isNewerGeneration(DATA: JsonObject, META: JsonObject): boolean {
  return META.version !== undefined || typeof META.fileCount === 'number' || isObject(DATA.profile);
}

/** META.version of an unsupported builder generation as text, or null when the version is absent or supported. */
export function unsupportedVersion(META: JsonObject): string | null {
  const v = META.version;
  if (v === undefined || (typeof v === 'string' && NEWER_VERSIONS.includes(v))) return null;
  return JSON.stringify(v).slice(0, 40);
}

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

function narrative(v: JsonValue | undefined): string {
  if (Array.isArray(v)) return v.map((x) => (isObject(x) ? Object.entries(x).map(([k, y]) => `${k}: ${narrative(y)}`).join(', ') : narrative(x))).join('\n');
  if (isObject(v)) return Object.entries(v).map(([k, y]) => `${k}: ${narrative(y)}`).join('\n');
  return str(v);
}

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

const withFilename = (rowsByRef: RowsByRef) => (r: JsonObject): JsonObject =>
  typeof r.filename === 'string' ? r : { ...r, filename: str(rowsByRef.get(str(r.ref))?.filename) || str(r.title) };

export function quantumOf(q: JsonObject, rowsByRef: RowsByRef): JsonObject {
  const fill = withFilename(rowsByRef);
  const out: JsonObject = { ...q };
  for (const k of ['amountDueSeries', 'statementSeries', 'interestSeries']) if (q[k] !== undefined) out[k] = mapObjs(q[k], fill)!;
  return out;
}

export function contractsOf(c: JsonObject, rowsByRef: RowsByRef): JsonObject {
  const item = (it: JsonObject): JsonObject => ({
    ...it,
    doc_type: it.doc_type ?? str(rowsByRef.get(str(it.ref))?.doc_type),
    party: it.party ?? '',
    role: it.role ?? '',
    note: typeof it.note === 'string' && it.note !== '' ? it.note : str(it.signed),
  });
  return { ...c, groups: mapObjs(c.groups, (g) => ({ ...g, items: mapObjs(g.items, item) ?? g.items })) ?? c.groups };
}

const seedOf = (r: JsonObject): JsonObject =>
  r.fdate !== undefined || r.fparty !== undefined ? r : { ...r, fdate: str(r.date), filing: str(r.filing), fparty: str(r.party), rdate: str(r.answerDate), ref: str(r.ref), response: str(r.answer), status: str(r.status) };

export function filingsOf(f: JsonObject): JsonObject {
  return {
    ...f,
    groups: mapObjs(f.groups, (g) => ({ ...g, note: g.note ?? '', items: mapObjs(g.items, (it) => ({ ...it, role: it.role ?? '' })) ?? g.items })) ?? f.groups,
    registerSeed: mapObjs(f.registerSeed, seedOf) ?? f.registerSeed,
  };
}

const bundleSlug = (no: string, name: string) => `${no}_${name}`.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);

export function bundlesOf(b: JsonObject): JsonObject {
  const bundle = (x: JsonObject): JsonObject => {
    const rows = mapObjs(x.rows, (r) => ({ ...r, from: r.from ?? count(r.frm) })) ?? x.rows;
    const keys = objs(rows).map((r) => str(r.key));
    const n = typeof x.items === 'number' ? count(x.items) : keys.length;
    return {
      ...x,
      slug: x.slug ?? bundleSlug(str(x.no), str(x.name)), planFile: x.planFile ?? '',
      bundlePages: x.bundlePages ?? count(x.bodyPages ?? x.pages), filePages: x.filePages ?? count(x.pages),
      nDocs: x.nDocs ?? n, nItems: x.nItems ?? n, nMissing: x.nMissing ?? 0, nNeedsExtent: x.nNeedsExtent ?? 0, nReview: x.nReview ?? 0,
      items: Array.isArray(x.items) ? x.items : keys,
      rows,
    };
  };
  const sections = Array.isArray(b.caselinesSections)
    ? Object.fromEntries(objs(b.caselinesSections).map((s) => [str(s.sec), { ...s, from: count(s.first), to: count(s.last), title: str(s.title) }]))
    : b.caselinesSections;
  return {
    ...b,
    source: b.source ?? '', indexSource: b.indexSource ?? '',
    catalogue: b.catalogue ?? {}, catCount: b.catCount ?? (isObject(b.catalogue) ? Object.keys(b.catalogue).length : 0),
    extracts: typeof b.extracts === 'string' ? b.extracts : '',
    ...(Array.isArray(b.extracts) && { extractFiles: b.extracts }),
    ...(sections !== undefined && { caselinesSections: sections }),
    list: mapObjs(b.list, bundle) ?? b.list,
  };
}

const nameOfLocator = (u: string): string => { const seg = u.split('/').pop() ?? ''; try { return decodeURIComponent(seg); } catch { return seg; } };

export function caselinesIndexOf(idx: JsonObject, caselinesSrc: string, pages: number): JsonObject {
  const index: JsonValue[] = [];
  const rest: JsonObject = {};
  for (const [k, t] of Object.entries(idx)) if (/^\d+$/.test(k)) index.push([Number(k), str(t)]); else own(rest, k, t);
  index.sort((a, b) => ((a as number[])[0]! - (b as number[])[0]!));
  return { ...rest, file: nameOfLocator(caselinesSrc), pages: pages || index.length, index };
}

export function schedOf(list: readonly JsonObject[]): JsonObject {
  const file = (f: JsonObject): JsonObject => ({ ...f, fn: f.fn ?? str(f.name), url: str(f.url), co: f.co ?? '' });
  const item = (i: JsonObject): JsonObject => {
    const files = mapObjs(i.files, file) ?? [];
    return { ...i, no: count(i.no), date: str(i.date), desc: str(i.desc), co: i.co ?? '', nfiles: i.nfiles ?? objs(files).length, files };
  };
  const of = (bundle: string) => list.filter((s) => str(s.bundle) === bundle).flatMap((s) => objs(s.items).map(item));
  return { discovery: of('Original'), supplementary: of('Supplementary'), schedules: [...list] };
}

const earliestDate = (rows: readonly JsonObject[]): string => rows.map((r) => str(r.date)).filter((d) => d !== '').sort()[0] ?? '';

export function interestBasisOf(ib: JsonObject, q: JsonObject): JsonObject {
  return {
    ...ib,
    award_date: ib.award_date ?? '',
    first_invoice_date: ib.first_invoice_date ?? earliestDate(objs(q.invoiceLedger)),
    headline_date: ib.headline_date ?? str(q.headline_date),
    headline_due: ib.headline_due ?? str(q.headline_due),
    note: ib.note ?? narrative(ib),
  };
}

export function settlementOf(s: JsonObject, q: JsonObject): JsonObject {
  return { ...s, claim: s.claim ?? str(q.headline_due), claimDate: s.claimDate ?? str(q.headline_date) };
}

export const linkSampleOf = (list: JsonValue, rowsByRef: RowsByRef): JsonValue => mapObjs(list, withFilename(rowsByRef)) ?? list;

export function buildReportOf(br: JsonObject, rowsByRef: RowsByRef): JsonObject {
  const fill = withFilename(rowsByRef);
  return { ...br, pending: mapObjs(br.pending, fill) ?? [], textNone: mapObjs(br.textNone, fill) ?? [] };
}

/** The V1 builder stores each document's extracted text in DATA.text and stops it at this many characters. */
export const TEXT_CAP = 4000;
const en = (n: number) => n.toLocaleString('en-US');

/** Reports how many DATA.text entries reach the cap; a value that is not text is counted as unmeasured, never as complete. */
export function reportTextCap(DATA: JsonObject, sink: DiagSink): void {
  const t = DATA.text;
  const entries = isObject(t) ? Object.values(t) : Array.isArray(t) ? t : t === undefined ? [] : [t];
  const atCap = entries.filter((x) => typeof x === 'string' && x.length >= TEXT_CAP).length;
  const unmeasured = entries.filter((x) => typeof x !== 'string').length;
  if (atCap === 0 && unmeasured === 0) return;
  sink.add('V5_TEXT_CAPPED', `${en(atCap)} of ${en(entries.length)} document texts (DATA.text) stop at the ${en(TEXT_CAP)}-character cap, so the export holds only their first ${en(TEXT_CAP)} characters`
    + (unmeasured ? `; ${en(unmeasured)} ${unmeasured === 1 ? 'entry is' : 'entries are'} not text and could not be measured` : ''), { file: 'input', subject: 'DATA.text' });
}

const hasMatter = (v: JsonValue | undefined): boolean => isObject(v) && typeof v.title === 'string';

export function mapNewerRoots(roots: Roots): Roots {
  if (!isObject(roots.DATA) || !isObject(roots.META)) return roots;
  const DATA = roots.DATA, META = roots.META;
  const rows = objs(DATA.chronology);
  const rowsByRef: RowsByRef = new Map(rows.map((r) => [str(r.ref), r]));
  const out: JsonObject = { ...DATA };
  if (isObject(DATA.profile) && !hasMatter(DATA.matter)) out.matter = matterOf(DATA.profile, META);
  if (isObject(DATA.quantum)) out.quantum = quantumOf(DATA.quantum, rowsByRef);
  if (isObject(DATA.contracts)) out.contracts = contractsOf(DATA.contracts, rowsByRef);
  if (isObject(DATA.filings)) out.filings = filingsOf(DATA.filings);
  if (isObject(DATA.bundles)) out.bundles = bundlesOf(DATA.bundles);
  if (DATA.linkSample !== undefined) out.linkSample = linkSampleOf(DATA.linkSample, rowsByRef);
  if (isObject(DATA.buildReport)) out.buildReport = buildReportOf(DATA.buildReport, rowsByRef);
  if (isObject(DATA.lit)) {
    const q = isObject(DATA.quantum) ? DATA.quantum : {};
    const lit: JsonObject = { ...DATA.lit };
    if (isObject(lit.interestBasis)) lit.interestBasis = interestBasisOf(lit.interestBasis, q);
    if (isObject(lit.settlement)) lit.settlement = settlementOf(lit.settlement, q);
    out.lit = lit;
  }
  const mapped: Roots = { ...roots, DATA: out, META: metaOf(META, rows) };
  const sched = roots['window.__SCHED__'];
  if (Array.isArray(sched)) mapped['window.__SCHED__'] = schedOf(sched.filter(isObject));
  const idx = roots['window.__CASELINES_IDX__'];
  if (isObject(idx) && !Array.isArray(idx.index)) mapped['window.__CASELINES_IDX__'] = caselinesIndexOf(idx, str(isObject(DATA.bundles) ? DATA.bundles.caselinesSrc : ''), count(META.caselinesPages));
  return mapped;
}
