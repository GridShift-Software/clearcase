// The newer workspace generation embeds its data as two JSON script tags, <script id="app-data"> and
// <script id="app-seed">, in place of the v5 `const DATA` and `const META` lines. This module maps the two
// documents onto the v5 roots (DATA, META and window.__SCHED__), so the datasets, the asset index and the
// validation behind extractV5 stay one pipeline. Pure: no I/O, no clock, nothing evaluated. Source values are
// carried over as written. A field with no v5 home stays on its record (preserved, reported as an unsupported
// field, not rendered); a top-level key with no v5 home reaches the package as a residual dataset through the
// adapter's unmapped-key path. The viewer's own full-text token index (`ft`) is the one thing left behind.
import type { DiagSink } from '../diagnostics.ts';
import { isObject, type JsonObject, type JsonValue } from '../strict-json.ts';
import type { V5Root } from './extract.ts';

export const JSON_SCRIPT_IDS = ['app-data', 'app-seed'] as const;
export type JsonScriptId = (typeof JSON_SCRIPT_IDS)[number];

const str = (v: JsonValue | undefined): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const num = (v: JsonValue | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const count = (v: JsonValue | undefined): number => Math.max(0, Math.trunc(num(v)));
const strs = (v: JsonValue | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const objs = (v: JsonValue | undefined): JsonObject[] => (Array.isArray(v) ? v.filter(isObject) : []);
const kebab = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'other';
const tally = (keys: Iterable<string>): Record<string, number> => { const c: Record<string, number> = {}; for (const k of keys) c[k] = (c[k] ?? 0) + 1; return c; };
const nonEmpty = (parts: string[]) => parts.filter((s) => s !== '');
/** Copies the source fields the v5 shape has no place for onto the mapped record. */
const carry = (into: JsonObject, from: JsonObject, keys: readonly string[]): JsonObject => { for (const k of keys) if (from[k] !== undefined) into[k] = from[k]!; return into; };

const AMOUNT = /^-?\d{1,15}(?:\.\d{1,4})?$/;
/** A source amount as the package's decimal text; '' when absent or outside the amount grammar. */
export function amountText(v: JsonValue | undefined): string {
  if (typeof v === 'string') return AMOUNT.test(v) ? v : '';
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  const plain = String(v);
  if (AMOUNT.test(plain)) return plain;
  const fixed = v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return AMOUNT.test(fixed) ? fixed : '';
}

/** Row fields kept beside the v5 shape: entity, matters, thread, duplicate-of, section, subfolder, firm, upload. */
const ROW_EXTRAS = ['ent', 'mt', 'th', 'dup', 'sec', 'sub', 'fm', 'up'] as const;

/** One app-data chronology row in the v5 row shape. `st` is the longer text of which `ex` is the head. */
export function chronologyRow(r: JsonObject): JsonObject {
  const row: JsonObject = {
    ref: str(r.ref), n: num(r.n), seq: num(r.n), date: str(r.date), filename: str(r.fn), subject: str(r.sj), sender: str(r.sd), to: str(r.to), cc: str(r.cc),
    excerpt: str(r.st) || str(r.ex), doc_type: str(r.dt), bundle: str(r.bd), amount: amountText(r.amt), also_in: strs(r.ai), text_status: str(r.ts), url: str(r.url),
    refs: [], invoice_no: '', size: count(r.sz), attachments: [],
  };
  if (typeof r.pr === 'string' && r.pr !== '') row.pr = r.pr;
  if (typeof r.ds === 'string' && r.ds !== '') row.date_source = r.ds;
  return carry(row, r, ROW_EXTRAS);
}

/** v5 META from the source meta and the mapped rows; the counts the validator compares come from the rows. */
export function metaOf(meta: JsonObject, rows: readonly JsonObject[], people: number): JsonObject {
  const by = (f: string) => tally(rows.map((r) => str(r[f])));
  const status = by('text_status'), types = by('doc_type');
  const dates = rows.map((r) => str(r.date)).filter((d) => d !== '').sort();
  return {
    builtAt: str(meta.builtAt), docCount: typeof meta.docCount === 'number' ? count(meta.docCount) : rows.length, dataFolderName: str(meta.dataFolderName),
    bundles: by('bundle'), emails: types.email ?? 0, invoices: types.invoice ?? 0, people, textNone: status.none ?? 0, textPending: status.pending ?? 0,
    dateSpan: dates.length ? [dates[0]!, dates[dates.length - 1]!] : [], docTypes: types,
  };
}

const headings = (v: JsonValue | undefined): JsonObject[] => (Array.isArray(v) ? v : []).filter((p): p is JsonValue[] => Array.isArray(p)).map((p) => ({ h: str(p[0]), t: str(p[1]) }));
const matterHead = (m: JsonObject) => `Matter ${str(m.id)}: ${str(m.title)}`;

/** The seed's matters as one v5 matter: each matter's storyline and strategy under its own heading, nothing dropped. */
export function matterOf(seed: JsonObject): JsonObject | undefined {
  const matters = objs(seed.matters);
  const client = str(seed.client);
  if (matters.length === 0 && client === '') return undefined;
  const title = client || str(matters[0]!.title);
  return {
    title, short: title, forum: matters.map((m) => `${str(m.id)}: ${str(m.forum)}`).join('; '),
    storyline: matters.flatMap((m) => [{ h: matterHead(m), t: nonEmpty([str(m.sub), str(m.parties), str(m.forum), str(m.posture)]).join('\n') }, ...headings(m.storyline)]),
    strategy: matters.flatMap((m) => [{ h: matterHead(m), t: str(m.posture) }, ...headings(m.strategy)]),
  };
}

const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

/** The contradiction list grouped by kind into v5 categories; a category's severity is its highest item's. */
export function contradictionsOf(list: readonly JsonObject[], rowsByRef: ReadonlyMap<string, JsonObject>): JsonObject | undefined {
  if (list.length === 0) return undefined;
  const cats = new Map<string, { title: string; severity: string; items: JsonObject[] }>();
  for (const c of list) {
    const title = str(c.kind) || 'Other';
    const cat = cats.get(kebab(title)) ?? { title, severity: 'low', items: [] };
    cats.set(kebab(title), cat);
    const sev = str(c.sev).toLowerCase();
    if ((SEVERITY_RANK[sev] ?? 0) > (SEVERITY_RANK[cat.severity] ?? 0)) cat.severity = sev;
    cat.items.push({
      label: nonEmpty([str(c.ent), str(c.year), str(c.dt)]).join(' · '), detail: str(c.note),
      rates: { LOW: amountText(c.lo), HIGH: amountText(c.hi), GAP: str(c.gap) },
      refs: strs(c.refs).map((ref) => ({ ref, amount: '', filename: str(rowsByRef.get(ref)?.filename), url: str(rowsByRef.get(ref)?.url) })),
    });
  }
  const categories = [...cats].map(([key, c]) => ({ key, title: c.title, severity: c.severity, explain: '', items: c.items }));
  return { byCat: Object.fromEntries(categories.map((c) => [c.key, c.items.length])), categories, checks: [], highCount: list.filter((c) => str(c.sev).toLowerCase() === 'high').length, total: list.length };
}

const personOf = (p: JsonObject): JsonObject => carry({ name: str(p.name), email: '', org: '', sent: count(p.sent), received: count(p.recv), total: count(p.sent) + count(p.recv), role: str(p.role) }, p, ['side']);
const entityOf = (e: JsonObject): JsonObject => carry({ name: str(e.name), note: '', role: str(e.role) }, e, ['key', 'count', 'first', 'last', 'tax']);
const riskOf = (r: JsonObject): JsonObject => carry({ issue: str(r.risk), likelihood: str(r.l), impact: str(r.i), mitigation: str(r.mit) }, r, ['id', 'matter', 'type', 'owner', 'target', 'res']);
const defenceOf = (d: JsonObject): JsonObject => ({ point: nonEmpty([str(d.matter) && `Matter ${str(d.matter)}`, str(d.opponent)]).join(' · '), dcs: str(d.contention), rebuttal: str(d.rebuttal), evidence: str(d.evidence), refs: '', docs: [] });
const infoOf = (i: JsonObject): JsonObject => carry({ item: str(i.doc), owner: str(i.src), status: str(i.pri) }, i, ['matter', 'grp', 'why']);
const witnessOf = (w: JsonObject): JsonObject => carry({ name: str(w.name), role: str(w.role), willsay: str(w.scope) }, w, ['matter', 'status']);
const elementOf = (e: JsonObject): JsonObject => carry({ element: str(e.cause), must: strs(e.els).join('; '), evidence: str(e.ev), witness: str(e.wit), tab: '' }, e, ['matter']);
const authorityOf = (a: JsonObject): JsonObject => carry({ topic: str(a.matter) && `Matter ${str(a.matter)}`, authority: nonEmpty([str(a.src), str(a.cite)]).join(' '), proposition: str(a.prop) }, a, ['note']);

/** The seed's discovery list as the discovery schedule: one item per row, no linked files. */
export function schedOf(discovery: readonly JsonObject[]): JsonObject | undefined {
  if (discovery.length === 0) return undefined;
  return { discovery: discovery.map((d, i) => carry({ no: i + 1, date: str(d.date), desc: str(d.doc), co: str(d.co), nfiles: 0, files: [] }, d, ['matter', 'grp'])), supplementary: [] };
}

/** The timeline as v5 builds it: the hot documents as events in date order, one phase per event year, the year tallies from the rows. */
export function timelineOf(rows: readonly JsonObject[], rowsByRef: ReadonlyMap<string, JsonObject>, hot: readonly JsonObject[]): JsonObject {
  const year = (d: string) => d.slice(0, 4);
  const dated = rows.filter((r) => str(r.date) !== '');
  const yearCounts = tally(dated.map((r) => year(str(r.date))));
  const typeByYear: Record<string, Record<string, number>> = {};
  for (const r of dated) { const y = typeByYear[year(str(r.date))] ??= {}; y[str(r.doc_type)] = (y[str(r.doc_type)] ?? 0) + 1; }
  const events = hot
    .map((h) => { const r = rowsByRef.get(str(h.ref)); return { date: str(r?.date), kind: str(r?.doc_type), note: str(h.why), ref: str(h.ref), title: str(r?.subject) || str(r?.filename), url: str(r?.url) }; })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const phases = [...new Set(events.map((e) => year(e.date)).filter((y) => y !== ''))].sort().map((y) => [y, `${yearCounts[y] ?? 0} ${yearCounts[y] === 1 ? 'document' : 'documents'} in ${y}`]);
  return { events, phases, yearCounts, typeByYear };
}

/** The agreements as the contracts register, grouped by document type. */
export function contractsOf(agreements: readonly JsonObject[], rowsByRef: ReadonlyMap<string, JsonObject>): JsonObject | undefined {
  if (agreements.length === 0) return undefined;
  const groups = new Map<string, JsonObject[]>();
  for (const a of agreements) {
    const key = str(a.dt) || 'agreement';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ date: str(a.date), doc_type: str(a.dt), note: str(a.ex), party: str(a.ent), ref: str(a.ref), role: '', text_status: str(rowsByRef.get(str(a.ref))?.text_status), title: str(a.fn), url: str(a.url) });
  }
  return { count: agreements.length, groups: [...groups].map(([key, items]) => ({ key, items })) };
}

const HEADER_KEYS = ['caseNo', 'claimant', 'claimantRole', 'court', 'defendant', 'defendantRole', 'intro', 'judge'] as const;

/** The bundle list in the v5 bundles shape; the item catalogue and CaseLines sections have no source here. */
export function bundlesOf(b: JsonObject): JsonObject {
  const list = objs(b.list).map((x) => {
    const rows = objs(x.rows).map((r) => ({
      key: str(r.key), n: count(r.n), desc: str(r.desc), from: count(r.from), to: count(r.to), pages: count(r.pages), date: str(r.date), blank: r.blank === true, missing: r.missing === true, review: r.review === true,
      parts: objs(r.parts).map((p) => ({ name: str(p.name), rel: str(p.rel), url: str(p.url), from: count(p.from), to: count(p.to) })),
    }));
    const name = str(x.name);
    return {
      no: str(x.no), name, slug: kebab(name), title: str(x.title), note: str(x.note), file: str(x.file), indexFile: str(x.indexFile), planFile: '',
      pages: count(x.pages), bundlePages: count(x.pages), filePages: count(x.filePages), indexPages: count(x.indexPages),
      nDocs: rows.length, nItems: rows.length, nMissing: rows.filter((r) => r.missing).length, nNeedsExtent: 0, nReview: rows.filter((r) => r.review).length,
      items: rows.map((r) => r.key), rows,
    };
  });
  const defaults = isObject(b.headerDefaults) ? b.headerDefaults : {};
  const sum = (f: 'nDocs' | 'nItems' | 'pages') => list.reduce((n, x) => n + x[f], 0);
  const out: JsonObject = {
    source: str(b.source), indexSource: str(b.indexSource), folder: str(b.folder), extracts: '', caselinesSrc: str(b.caselinesSrc),
    count: list.length, catCount: 0, totalDocs: sum('nDocs'), totalItems: sum('nItems'), totalPages: sum('pages'),
    headerDefaults: Object.fromEntries(HEADER_KEYS.map((k) => [k, str(defaults[k])])), caselinesSections: {}, catalogue: {}, list,
  };
  return carry(out, b, ['headerProvenance']);
}

/** app-data keys with a v5 home; every other key becomes a residual dataset. */
const MAPPED_DATA_KEYS = new Set(['chronology', 'people', 'entities', 'contradictions', 'agreements', 'bundles', 'meta', 'ft']);
/** app-seed keys with a v5 home; every other key becomes a residual dataset. */
const MAPPED_SEED_KEYS = new Set(['client', 'matters', 'risk', 'vdm', 'inforeq', 'witnesses', 'elements', 'authorities', 'discovery']);

/** The v5 roots for the two JSON documents. `appSeed` may be empty when the HTML carries no seed. */
export function toV5Roots(appData: JsonObject, appSeed: JsonObject, sink: DiagSink): Partial<Record<V5Root, JsonValue>> {
  const rows = objs(appData.chronology).map(chronologyRow);
  const rowsByRef = new Map(rows.map((r) => [str(r.ref), r]));
  const people = objs(appData.people).map(personOf);
  const DATA: JsonObject = { chronology: rows, people, entities: objs(appData.entities).map(entityOf), timeline: timelineOf(rows, rowsByRef, objs(appData.hot)) };
  const put = (key: string, v: JsonValue | undefined) => { if (v !== undefined) DATA[key] = v; };
  const list = (key: string, items: JsonObject[]) => put(key, items.length ? items : undefined);
  put('matter', matterOf(appSeed));
  put('contradictions', contradictionsOf(objs(appData.contradictions), rowsByRef));
  list('riskMatrix', objs(appSeed.risk).map(riskOf));
  list('defenceMatrix', objs(appSeed.vdm).map(defenceOf));
  list('infoRequired', objs(appSeed.inforeq).map(infoOf));
  list('witnesses', objs(appSeed.witnesses).map(witnessOf));
  put('contracts', contractsOf(objs(appData.agreements), rowsByRef));
  if (isObject(appData.bundles)) put('bundles', bundlesOf(appData.bundles));
  const lit: JsonObject = {};
  if (objs(appSeed.elements).length) lit.elements = objs(appSeed.elements).map(elementOf);
  if (objs(appSeed.authorities).length) lit.authorities = objs(appSeed.authorities).map(authorityOf);
  if (Object.keys(lit).length) DATA.lit = lit;
  // residual: the source meta, then every key of either document without a v5 home (a seed key never shadows a data key)
  if (isObject(appData.meta)) DATA.meta = appData.meta;
  for (const [k, v] of Object.entries(appData)) if (!MAPPED_DATA_KEYS.has(k) && !Object.hasOwn(DATA, k)) DATA[k] = v;
  for (const [k, v] of Object.entries(appSeed)) if (!MAPPED_SEED_KEYS.has(k) && !Object.hasOwn(DATA, k)) DATA[k] = v;
  if (appData.ft !== undefined) sink.add('V5_SOURCE_INDEX_DROPPED', "app-data.ft is the viewer's full-text token index; not carried into the package (ClearCase indexes on its own)", { file: 'input', subject: 'app-data.ft' });
  const roots: Partial<Record<V5Root, JsonValue>> = { DATA, META: metaOf(isObject(appData.meta) ? appData.meta : {}, rows, people.length) };
  const sched = schedOf(objs(appSeed.discovery));
  if (sched) roots['window.__SCHED__'] = sched;
  return roots;
}
