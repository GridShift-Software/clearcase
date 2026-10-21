import type { DiagSink } from '../diagnostics.ts';
import { isObject, type JsonObject, type JsonValue } from '../strict-json.ts';
import { carryTyped, fits, keepRest, own, putDerived, sourceName, type Kind } from './carry.ts';
import type { V5Root } from './extract.ts';

type Roots = Partial<Record<V5Root, JsonValue>>;
type RowsByRef = ReadonlyMap<string, JsonObject>;

const str = (v: JsonValue | undefined): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const num = (v: JsonValue | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const count = (v: JsonValue | undefined): number => Math.max(0, Math.trunc(num(v)));
const objs = (v: JsonValue | undefined): JsonObject[] => (Array.isArray(v) ? v.filter(isObject) : []);
const nonEmpty = (parts: string[]) => parts.filter((s) => s !== '');
const tally = (keys: Iterable<string>): Record<string, number> => { const c: Record<string, number> = {}; for (const k of keys) own(c, k, (Object.hasOwn(c, k) ? c[k]! : 0) + 1); return c; };
const mapObjs = (v: JsonValue | undefined, f: (o: JsonObject) => JsonObject): JsonValue | undefined => (Array.isArray(v) ? v.map((x) => (isObject(x) ? f(x) : x)) : v);

/**
 * `into` with each of `writes` written over the source value of its name. A source value the write does not carry moves
 * aside first (putDerived), so nothing is overwritten: one that is not null or empty text, not the value written, and not
 * a number or boolean written as its text.
 */
const writeOver = (into: JsonObject, writes: JsonObject): JsonObject => {
  for (const [k, v] of Object.entries(writes)) {
    const held = Object.hasOwn(into, k) ? into[k] : null;
    if (held === null || held === '' || held === v || (typeof held !== 'object' && v === String(held))) own(into, k, v);
    else putDerived(into, k, v);
  }
  return into;
};

/** The builder versions this adapter maps. Another META.version is a generation nobody has inventoried. */
export const NEWER_VERSIONS: readonly string[] = ['V1'];

/** The newer builder stamps META.version and META.fileCount and writes a DATA.profile; v5 has none of them. */
export function isNewerGeneration(DATA: JsonObject, META: JsonObject): boolean {
  return META.version !== undefined || typeof META.fileCount === 'number' || isObject(DATA.profile);
}

/** META.version of an unsupported builder generation as text ("absent" when a newer marker comes without one), or null when it is supported. */
export function unsupportedVersion(META: JsonObject): string | null {
  const v = META.version;
  if (v === undefined) return 'absent';
  if (typeof v === 'string' && NEWER_VERSIONS.includes(v)) return null;
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
  typeof r.filename === 'string' ? r : writeOver({ ...r }, { filename: str(rowsByRef.get(str(r.ref))?.filename) || str(r.title) });

export function quantumOf(q: JsonObject, rowsByRef: RowsByRef): JsonObject {
  const fill = withFilename(rowsByRef);
  const out: JsonObject = { ...q };
  for (const k of ['amountDueSeries', 'statementSeries', 'interestSeries']) if (q[k] !== undefined) out[k] = mapObjs(q[k], fill)!;
  return out;
}

export function contractsOf(c: JsonObject, rowsByRef: RowsByRef): JsonObject {
  const item = (it: JsonObject): JsonObject => writeOver({
    ...it,
    doc_type: it.doc_type ?? str(rowsByRef.get(str(it.ref))?.doc_type),
    party: it.party ?? '',
    role: it.role ?? '',
  }, { note: typeof it.note === 'string' && it.note !== '' ? it.note : str(it.signed) });
  return { ...c, groups: mapObjs(c.groups, (g) => ({ ...g, items: mapObjs(g.items, item) ?? g.items })) ?? c.groups };
}

const seedOf = (r: JsonObject): JsonObject =>
  r.fdate !== undefined || r.fparty !== undefined ? r : writeOver({ ...r }, { fdate: str(r.date), filing: str(r.filing), fparty: str(r.party), rdate: str(r.answerDate), ref: str(r.ref), response: str(r.answer), status: str(r.status) });

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
    const out: JsonObject = {
      ...x,
      slug: x.slug ?? bundleSlug(str(x.no), str(x.name)), planFile: x.planFile ?? '',
      bundlePages: x.bundlePages ?? count(x.bodyPages ?? x.pages), filePages: x.filePages ?? count(x.pages),
      nDocs: x.nDocs ?? n, nItems: x.nItems ?? n, nMissing: x.nMissing ?? 0, nNeedsExtent: x.nNeedsExtent ?? 0, nReview: x.nReview ?? 0,
    };
    // a count in items is read as nDocs and nItems, and the row keys take its place; a count neither keeps moves aside
    const items = Array.isArray(x.items) ? x.items : keys;
    if (typeof x.items === 'number' && (out.nDocs === x.items || out.nItems === x.items)) out.items = items;
    else writeOver(out, { items });
    return Object.assign(out, { rows });
  };
  const sections = Array.isArray(b.caselinesSections)
    ? Object.fromEntries(objs(b.caselinesSections).map((s) => [str(s.sec), writeOver({ ...s }, { from: count(s.first), to: count(s.last), title: str(s.title) })]))
    : b.caselinesSections;
  const out: JsonObject = {
    ...b,
    source: b.source ?? '', indexSource: b.indexSource ?? '',
    catalogue: b.catalogue ?? {}, catCount: b.catCount ?? (isObject(b.catalogue) ? Object.keys(b.catalogue).length : 0),
  };
  // a list of extracts moves to extractFiles and leaves the text empty; extracts of another kind is read as text
  if (Array.isArray(b.extracts)) writeOver(own(out, 'extracts', ''), { extractFiles: b.extracts });
  else writeOver(out, { extracts: typeof b.extracts === 'string' ? b.extracts : '' });
  return Object.assign(out, sections !== undefined ? { caselinesSections: sections } : {}, { list: mapObjs(b.list, bundle) ?? b.list });
}

const nameOfLocator = (u: string): string => { const seg = u.split('/').pop() ?? ''; try { return decodeURIComponent(seg); } catch { return seg; } };

export function caselinesIndexOf(idx: JsonObject, caselinesSrc: string, pages: number): JsonObject {
  const index: JsonValue[] = [];
  const rest: JsonObject = {};
  for (const [k, t] of Object.entries(idx)) if (/^\d+$/.test(k)) index.push([Number(k), str(t)]); else own(rest, k, t);
  index.sort((a, b) => ((a as number[])[0]! - (b as number[])[0]!));
  return writeOver(rest, { file: nameOfLocator(caselinesSrc), pages: pages || index.length, index });
}

export function schedOf(list: readonly JsonObject[]): JsonObject {
  const file = (f: JsonObject): JsonObject => writeOver({ ...f }, { fn: f.fn ?? str(f.name), url: str(f.url), co: f.co ?? '' });
  const item = (i: JsonObject): JsonObject => {
    const files = mapObjs(i.files, file) ?? [];
    // files is the same list mapped file by file, so it replaces the source's and is not a collision
    return own(writeOver({ ...i }, { no: count(i.no), date: str(i.date), desc: str(i.desc), co: i.co ?? '', nfiles: i.nfiles ?? objs(files).length }), 'files', files);
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

/** The risk fields the Risk Matrix types as optional text or text lists; a value of another type stays on the risk as `source_<name>` so it cannot demote the matrix. */
export function riskMatrixOf(list: JsonValue | undefined): JsonValue | undefined {
  return mapObjs(list, (r) => {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(r)) if (!(k === 'category' || k === 'owner' || k === 'refs')) own(out, k, v);
    for (const [k, kind] of [['category', 'text'], ['owner', 'text'], ['refs', 'strs']] as const) carryTyped(out, r, k, kind);
    return out;
  });
}

// The newer viewer's analysis records (GRS-149) in the v5 shapes. A record already in the v5 shape stays as written.

/** A record with source fields under their v5 names, each only where the v5 name is absent and the value is that kind; the rest stays as written. */
function renamed(r: JsonObject, names: Readonly<Record<string, readonly [to: string, kind: Kind]>>): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(r)) {
    const to = Object.hasOwn(names, k) ? names[k] : undefined;
    own(out, to && !Object.hasOwn(r, to[0]) && v !== null && fits(to[1], v) ? to[0] : k, v);
  }
  return out;
}

/** Matter headings written as [heading, text] pairs become v5's {h, t}; a list of anything else stays as written. */
const headingsOf = (v: JsonValue | undefined): JsonValue | undefined =>
  Array.isArray(v) && v.length > 0 && fits('pairs', v) ? v.map((p) => ({ h: (p as string[])[0]!, t: (p as string[])[1]! })) : v;
export function analysisMatterOf(m: JsonObject): JsonObject {
  const out: JsonObject = { ...m };
  for (const k of ['storyline', 'strategy']) if (Object.hasOwn(m, k)) out[k] = headingsOf(m[k])!;
  return out;
}

const docLinkOf = (ref: string, rowsByRef: RowsByRef): JsonObject => {
  const r = rowsByRef.get(ref);
  return { date: str(r?.date), doc_type: str(r?.doc_type), filename: str(r?.filename), ref, url: str(r?.url) };
};
const firstRef = (v: JsonValue | undefined): string => (Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '');

/** A newer timeline event ({date, title, detail, phase, type, refs}): v5's kind and note, its first ref with that row's url; phase and refs stay on it. */
export function timelineEventOf(e: JsonObject, rowsByRef: RowsByRef): JsonObject {
  if (['kind', 'note', 'ref', 'url'].some((k) => Object.hasOwn(e, k))) return e;
  const ref = firstRef(e.refs);
  return keepRest({ date: typeof e.date === 'string' ? e.date : '', kind: str(e.type), note: str(e.detail), ref, title: str(e.title), url: str(rowsByRef.get(ref)?.url) }, e, ['date', 'title', 'type', 'detail'], { date: 'text' });
}

/** A newer defence row ({point, theirs, evidence, docs: refs, rebuttal}): theirs is v5's dcs, and each cited ref a document link. */
export function defenceRowOf(r: JsonObject, rowsByRef: RowsByRef): JsonObject {
  if (Object.hasOwn(r, 'dcs') || !Object.hasOwn(r, 'theirs')) return r;
  const docs = fits('strs', r.docs) && Array.isArray(r.docs) ? (r.docs as string[]).map((ref) => docLinkOf(ref, rowsByRef)) : [];
  return keepRest({ point: str(r.point), dcs: str(r.theirs), rebuttal: str(r.rebuttal), evidence: str(r.evidence), refs: '', docs }, r, ['point', 'theirs', 'rebuttal', 'evidence', 'docs'], { docs: 'strs' });
}

/**
 * Newer contradictions: an item's cited refs become v5's document links. A check without v5's count `n` cannot be
 * one of v5's checks, so the source checks stay beside them as `source_checks` and no count is invented. A source that
 * already holds `source_checks` is never overwritten: the checks stay where it wrote them and the dataset's shape check demotes it whole.
 */
export function contradictionsOf(c: JsonObject, rowsByRef: RowsByRef): JsonObject {
  const item = (it: JsonObject): JsonObject => (Array.isArray(it.refs) && it.refs.length > 0 && fits('strs', it.refs)
    ? { ...it, refs: (it.refs as string[]).map((ref) => ({ ref, amount: '', filename: str(rowsByRef.get(ref)?.filename), url: str(rowsByRef.get(ref)?.url) })) }
    : it);
  const out: JsonObject = { ...c };
  if (Array.isArray(c.categories)) out.categories = mapObjs(c.categories, (cat) => (Array.isArray(cat.items) ? { ...cat, items: mapObjs(cat.items, item)! } : cat))!;
  if (Array.isArray(c.checks) && !Object.hasOwn(c, sourceName('checks')) && !c.checks.every((x) => isObject(x) && typeof x.n === 'number')) { out.checks = []; own(out, sourceName('checks'), c.checks); }
  return out;
}

/** A newer cross-examination seed cites its documents as a list of refs; v5 holds them as one line of text. */
const crossexamSeedOf = (r: JsonObject): JsonObject => (Array.isArray(r.docs) && fits('strs', r.docs) ? { ...r, docs: (r.docs as string[]).join(', ') } : r);

/** The profile stands in for the matter only where DATA.matter is absent or empty, as the newer builder writes it before its analysis module runs. */
const emptyMatter = (v: JsonValue | undefined): boolean => v === undefined || (isObject(v) && Object.keys(v).length === 0);

export function mapNewerRoots(roots: Roots): Roots {
  if (!isObject(roots.DATA) || !isObject(roots.META)) return roots;
  const DATA = roots.DATA, META = roots.META;
  const rows = objs(DATA.chronology);
  const rowsByRef: RowsByRef = new Map(rows.map((r) => [str(r.ref), r]));
  const out: JsonObject = { ...DATA };
  if (isObject(DATA.profile) && emptyMatter(DATA.matter)) out.matter = matterOf(DATA.profile, META);
  else if (isObject(DATA.matter)) out.matter = analysisMatterOf(DATA.matter);
  if (isObject(DATA.timeline) && Array.isArray(DATA.timeline.events)) out.timeline = { ...DATA.timeline, events: mapObjs(DATA.timeline.events, (e) => timelineEventOf(e, rowsByRef))! };
  if (DATA.defenceMatrix !== undefined) out.defenceMatrix = mapObjs(DATA.defenceMatrix, (r) => defenceRowOf(r, rowsByRef))!;
  if (isObject(DATA.contradictions)) out.contradictions = contradictionsOf(DATA.contradictions, rowsByRef);
  if (isObject(DATA.quantum)) out.quantum = quantumOf(DATA.quantum, rowsByRef);
  if (isObject(DATA.contracts)) out.contracts = contractsOf(DATA.contracts, rowsByRef);
  if (isObject(DATA.filings)) out.filings = filingsOf(DATA.filings);
  if (isObject(DATA.bundles)) out.bundles = bundlesOf(DATA.bundles);
  if (DATA.riskMatrix !== undefined) out.riskMatrix = riskMatrixOf(DATA.riskMatrix)!;
  if (DATA.linkSample !== undefined) out.linkSample = linkSampleOf(DATA.linkSample, rowsByRef);
  if (isObject(DATA.buildReport)) out.buildReport = buildReportOf(DATA.buildReport, rowsByRef);
  if (isObject(DATA.lit)) {
    const q = isObject(DATA.quantum) ? DATA.quantum : {};
    const lit: JsonObject = { ...DATA.lit };
    if (isObject(lit.interestBasis)) lit.interestBasis = interestBasisOf(lit.interestBasis, q);
    if (isObject(lit.settlement)) lit.settlement = settlementOf(lit.settlement, q);
    if (lit.elements !== undefined) lit.elements = mapObjs(lit.elements, (e) => renamed(e, { goto: ['tab', 'text'] }))!;
    if (lit.recon !== undefined) lit.recon = mapObjs(lit.recon, (r) => renamed(r, { period: ['month', 'text'], due: ['amountdue', 'strs'] }))!;
    if (lit.crossexam_seed !== undefined) lit.crossexam_seed = mapObjs(lit.crossexam_seed, crossexamSeedOf)!;
    out.lit = lit;
  }
  const mapped: Roots = { ...roots, DATA: out, META: metaOf(META, rows) };
  const sched = roots['window.__SCHED__'];
  if (Array.isArray(sched)) mapped['window.__SCHED__'] = schedOf(sched.filter(isObject));
  const idx = roots['window.__CASELINES_IDX__'];
  if (isObject(idx) && !Array.isArray(idx.index)) mapped['window.__CASELINES_IDX__'] = caselinesIndexOf(idx, str(isObject(DATA.bundles) ? DATA.bundles.caselinesSrc : ''), count(META.caselinesPages));
  return mapped;
}
