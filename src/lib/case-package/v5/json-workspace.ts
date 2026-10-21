import { fmtR } from '../../components/format.ts';
import type { DiagSink } from '../diagnostics.ts';
import { isObject, type JsonObject, type JsonValue } from '../strict-json.ts';
import { amountText, carryTyped, fits, keepAside, keepRest, own, ownOrAside, putDerived, type Kind, type Kinds } from './carry.ts';
import type { V5Root } from './extract.ts';

export { amountText };

export const JSON_SCRIPT_IDS = ['app-data', 'app-seed'] as const;
export type JsonScriptId = (typeof JSON_SCRIPT_IDS)[number];

const str = (v: JsonValue | undefined): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const num = (v: JsonValue | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const count = (v: JsonValue | undefined): number => Math.max(0, Math.trunc(num(v)));
const strs = (v: JsonValue | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const objs = (v: JsonValue | undefined): JsonObject[] => (Array.isArray(v) ? v.filter(isObject) : []);
const kebab = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'other';
const tally = (keys: Iterable<string>): Record<string, number> => { const c: Record<string, number> = {}; for (const k of keys) own(c, k, (Object.hasOwn(c, k) ? c[k]! : 0) + 1); return c; };
const nonEmpty = (parts: string[]) => parts.filter((s) => s !== '');
/** A row position as the source wrote it: v5 writes text, the JSON script numbers. */
const position = (v: JsonValue | undefined): number | string => (typeof v === 'string' ? v : num(v));

/**
 * Every source field each mapper reads, by record kind. A read field must land in the mapped record, or the mapper
 * keeps it under its own name (keepRest); `read-lists.test.ts` walks this table, so a key cannot be read and vanish.
 */
export const READ = {
  /** the row fields the v5 shape reads; `ex` is the head of `st`, and an empty `pr` or `ds` says nothing */
  row: ['n', 'ref', 'date', 'fn', 'sj', 'sd', 'to', 'cc', 'st', 'ex', 'dt', 'bd', 'amt', 'ai', 'ts', 'url', 'sz', 'pr', 'ds'],
  contradiction: ['kind', 'ent', 'year', 'dt', 'note', 'refs', 'lo', 'hi', 'gap', 'sev'],
  person: ['name', 'sent', 'recv', 'role'],
  entity: ['name', 'role'],
  risk: ['risk', 'l', 'i', 'mit'],
  defence: ['matter', 'opponent', 'contention', 'rebuttal', 'evidence'],
  info: ['doc', 'src', 'pri'],
  witness: ['name', 'role', 'scope'],
  element: ['cause', 'els', 'ev', 'wit'],
  authority: ['matter', 'src', 'cite', 'prop'],
  discovery: ['date', 'doc', 'co'],
  /** `n` is the agreement's chronology position, which the row of its ref carries */
  agreement: ['date', 'dt', 'ex', 'ent', 'ref', 'fn', 'url', 'n'],
  bundle: ['no', 'name', 'title', 'note', 'file', 'indexFile', 'pages', 'filePages', 'indexPages', 'rows'],
  bundleRow: ['key', 'n', 'desc', 'from', 'to', 'pages', 'date', 'blank', 'missing', 'review', 'parts'],
  bundlePart: ['name', 'rel', 'url', 'from', 'to'],
  bundles: ['source', 'indexSource', 'folder', 'caselinesSrc', 'headerDefaults', 'list'],
  matter: ['id', 'title', 'sub', 'forum', 'parties', 'posture', 'storyline', 'strategy'],
} as const;

/** The type each read key needs; a key not named is text. A value of another type is kept on the record, not read as empty. */
const KIND: Partial<Record<keyof typeof READ, Kinds>> = {
  row: { n: 'pos', amt: 'amount', ai: 'strs', sz: 'num', pr: 'text', ds: 'text' },
  contradiction: { refs: 'strs', lo: 'amount', hi: 'amount', gap: 'amount' },
  person: { sent: 'num', recv: 'num' },
  risk: { l: 'level', i: 'level' },
  element: { els: 'strs' },
  agreement: { n: 'pos' },
  bundle: { pages: 'num', filePages: 'num', indexPages: 'num', rows: 'objs' },
  bundleRow: { n: 'num', from: 'num', to: 'num', pages: 'num', blank: 'bool', missing: 'bool', review: 'bool', parts: 'objs' },
  bundlePart: { from: 'num', to: 'num' },
  bundles: { headerDefaults: 'object', list: 'objs' },
  matter: { storyline: 'pairs', strategy: 'pairs' },
};

/** One app-data chronology row in the v5 row shape. `st` is the longer text of which `ex` is the head; an `ex` that is not stays on the row. */
export function chronologyRow(r: JsonObject): JsonObject {
  const row: JsonObject = {
    ref: str(r.ref), n: position(r.n), seq: position(r.n), date: str(r.date), filename: str(r.fn), subject: str(r.sj), sender: str(r.sd), to: str(r.to), cc: str(r.cc),
    excerpt: str(r.st) || str(r.ex), doc_type: str(r.dt), bundle: str(r.bd), amount: amountText(r.amt), also_in: strs(r.ai), text_status: str(r.ts), url: str(r.url),
    refs: [], invoice_no: '', size: count(r.sz), attachments: [],
  };
  if (typeof r.pr === 'string' && r.pr !== '') row.pr = r.pr;
  if (typeof r.ds === 'string' && r.ds !== '') row.date_source = r.ds;
  const exIsHead = typeof r.ex !== 'string' || r.ex === '' || (typeof r.st === 'string' && (r.st === '' || r.st.startsWith(r.ex)));
  return keepRest(row, r, exIsHead ? READ.row : READ.row.filter((k) => k !== 'ex'), KIND.row);
}

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

export function matterOf(seed: JsonObject): JsonObject | undefined {
  const matters = objs(seed.matters);
  const client = str(seed.client);
  const clientOdd = Object.hasOwn(seed, 'client') && !fits('str', seed.client);
  if (matters.length === 0 && client === '' && !clientOdd) return undefined;
  const title = client || str(matters[0]?.title);
  const matter: JsonObject = {
    title, short: title, forum: matters.map((m) => `${str(m.id)}: ${str(m.forum)}`).join('; '),
    storyline: matters.flatMap((m) => [{ h: matterHead(m), t: nonEmpty([str(m.sub), str(m.parties), str(m.forum), str(m.posture)]).join('\n') }, ...headings(m.storyline)]),
    strategy: matters.flatMap((m) => [{ h: matterHead(m), t: str(m.posture) }, ...headings(m.strategy)]),
  };
  // one record holds every matter, so what a matter carries beyond the keys above travels beside it, matter by matter
  const beside = matters.flatMap((m, at) => { const rest = keepRest({ at }, m, READ.matter, KIND.matter); return Object.keys(rest).length > 1 ? [rest] : []; });
  if (beside.length) keepAside(matter, 'matters', beside);
  if (clientOdd) keepAside(matter, 'client', seed.client);
  return matter;
}

const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

function contradictionItem(c: JsonObject, rowsByRef: ReadonlyMap<string, JsonObject>): JsonObject {
  const item: JsonObject = {
    label: nonEmpty([str(c.ent), str(c.year), str(c.dt)]).join(' · '), detail: str(c.note),
    refs: strs(c.refs).map((ref) => ({ ref, amount: '', filename: str(rowsByRef.get(ref)?.filename), url: str(rowsByRef.get(ref)?.url) })),
  };
  const lo = amountText(c.lo), hi = amountText(c.hi), gap = amountText(c.gap);
  if (lo !== '' || hi !== '' || gap !== '') {
    item.rates = { LOW: lo, HIGH: hi, GAP: gap };
    item.spread = nonEmpty([lo && `low ${fmtR(lo)}`, hi && `high ${fmtR(hi)}`, gap && `gap ${gap}%`]).join(', ');
  }
  // `sev` ranks the category but stays on its own item: a category mixes severities
  return keepRest(item, c, READ.contradiction.filter((k) => k !== 'sev'), KIND.contradiction);
}

export function contradictionsOf(list: readonly JsonObject[], rowsByRef: ReadonlyMap<string, JsonObject>): JsonObject | undefined {
  if (list.length === 0) return undefined;
  const cats = new Map<string, { title: string; severity: string; items: JsonObject[] }>();
  for (const c of list) {
    const title = str(c.kind) || 'Other';
    const cat = cats.get(kebab(title)) ?? { title, severity: 'low', items: [] };
    cats.set(kebab(title), cat);
    const sev = str(c.sev).toLowerCase();
    if ((SEVERITY_RANK[sev] ?? 0) > (SEVERITY_RANK[cat.severity] ?? 0)) cat.severity = sev;
    cat.items.push(contradictionItem(c, rowsByRef));
  }
  const categories = [...cats].map(([key, c]) => ({ key, title: c.title, severity: c.severity, explain: '', items: c.items }));
  return { byCat: Object.fromEntries(categories.map((c) => [c.key, c.items.length])), categories, checks: [], highCount: list.filter((c) => str(c.sev).toLowerCase() === 'high').length, total: list.length };
}

const personOf = (p: JsonObject): JsonObject => keepRest({ name: str(p.name), email: '', org: '', sent: count(p.sent), received: count(p.recv), total: count(p.sent) + count(p.recv), role: str(p.role) }, p, READ.person, KIND.person);
const entityOf = (e: JsonObject): JsonObject => keepRest({ name: str(e.name), note: '', role: str(e.role) }, e, READ.entity);
export const riskLevel = (v: JsonValue | undefined): string => (typeof v !== 'number' ? str(v) : v >= 4 ? 'High' : v >= 3 ? 'Medium' : v >= 1 ? 'Low' : str(v));
const riskOf = (r: JsonObject): JsonObject => {
  const handled: string[] = [];
  const out: JsonObject = { issue: str(r.risk), likelihood: riskLevel(r.l), impact: riskLevel(r.i), mitigation: str(r.mit) };
  // `type` is the newer builder's `category`; a risk that names both keeps the other as written. Category, owner and refs
  // are written only with the schema's type, so one odd field never demotes the whole matrix.
  const named = ['category', 'type'].filter((k) => Object.hasOwn(r, k));
  const chosen = named.find((k) => typeof r[k] === 'string');
  if (chosen) { own(out, 'category', r[chosen]); handled.push(chosen); }
  for (const k of named) if (k !== chosen && typeof r[k] !== 'string') { keepAside(out, k, r[k]); handled.push(k); }
  for (const [k, kind] of [['owner', 'text'], ['refs', 'strs']] as const) if (carryTyped(out, r, k, kind)) handled.push(k);
  keepRest(out, r, READ.risk, KIND.risk, handled);
  if (typeof r.l === 'number') putDerived(out, 'likelihood_score', r.l);
  if (typeof r.i === 'number') putDerived(out, 'impact_score', r.i);
  return out;
};
const defenceOf = (d: JsonObject): JsonObject => keepRest({ point: nonEmpty([str(d.matter) && `Matter ${str(d.matter)}`, str(d.opponent)]).join(' · '), dcs: str(d.contention), rebuttal: str(d.rebuttal), evidence: str(d.evidence), refs: '', docs: [] }, d, READ.defence);
const infoOf = (i: JsonObject): JsonObject => keepRest({ item: str(i.doc), owner: str(i.src), status: str(i.pri) }, i, READ.info);
const witnessOf = (w: JsonObject): JsonObject => keepRest({ name: str(w.name), role: str(w.role), willsay: str(w.scope) }, w, READ.witness);
const elementOf = (e: JsonObject): JsonObject => keepRest({ element: str(e.cause), must: strs(e.els).join('; '), evidence: str(e.ev), witness: str(e.wit), tab: '' }, e, READ.element, KIND.element);
const authorityOf = (a: JsonObject): JsonObject => keepRest({ topic: str(a.matter) && `Matter ${str(a.matter)}`, authority: nonEmpty([str(a.src), str(a.cite)]).join(' '), proposition: str(a.prop) }, a, READ.authority);

export function schedOf(discovery: readonly JsonObject[]): JsonObject | undefined {
  if (discovery.length === 0) return undefined;
  return { discovery: discovery.map((d, i) => keepRest({ no: i + 1, date: str(d.date), desc: str(d.doc), co: str(d.co), nfiles: 0, files: [] }, d, READ.discovery)), supplementary: [] };
}

export function timelineOf(rows: readonly JsonObject[], rowsByRef: ReadonlyMap<string, JsonObject>, hot: readonly JsonObject[]): JsonObject {
  const year = (d: string) => d.slice(0, 4);
  const dated = rows.filter((r) => str(r.date) !== '');
  const yearCounts = tally(dated.map((r) => year(str(r.date))));
  const typeByYear: Record<string, Record<string, number>> = {};
  for (const y of Object.keys(yearCounts)) own(typeByYear, y, tally(dated.filter((r) => year(str(r.date)) === y).map((r) => str(r.doc_type))));
  const events = hot
    .map((h) => { const r = rowsByRef.get(str(h.ref)); return { date: str(r?.date), kind: str(r?.doc_type), note: str(h.why), ref: str(h.ref), title: str(r?.subject) || str(r?.filename), url: str(r?.url) }; })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const phases = [...new Set(events.map((e) => year(e.date)).filter((y) => y !== ''))].sort().map((y) => [y, `${yearCounts[y] ?? 0} ${yearCounts[y] === 1 ? 'document' : 'documents'} in ${y}`]);
  return { events, phases, yearCounts, typeByYear };
}

export function contractsOf(agreements: readonly JsonObject[], rowsByRef: ReadonlyMap<string, JsonObject>): JsonObject | undefined {
  if (agreements.length === 0) return undefined;
  const groups = new Map<string, JsonObject[]>();
  for (const a of agreements) {
    const key = str(a.dt) || 'agreement';
    if (!groups.has(key)) groups.set(key, []);
    const item = { date: str(a.date), doc_type: str(a.dt), note: str(a.ex), party: str(a.ent), ref: str(a.ref), role: '', text_status: str(rowsByRef.get(str(a.ref))?.text_status), title: str(a.fn), url: str(a.url) };
    // the agreement's position is redundant only where its chronology row carries the same one
    const rowN = rowsByRef.get(str(a.ref))?.n;
    groups.get(key)!.push(keepRest(item, a, rowN !== undefined && rowN === a.n ? READ.agreement : READ.agreement.filter((k) => k !== 'n'), KIND.agreement));
  }
  return { count: agreements.length, groups: [...groups].map(([key, items]) => ({ key, items })) };
}

const HEADER_KEYS = ['caseNo', 'claimant', 'claimantRole', 'court', 'defendant', 'defendantRole', 'intro', 'judge'] as const;

export function bundlesOf(b: JsonObject): JsonObject {
  const list = objs(b.list).map((x) => {
    const rows = objs(x.rows).map((r) => keepRest({
      key: str(r.key), n: count(r.n), desc: str(r.desc), from: count(r.from), to: count(r.to), pages: count(r.pages), date: str(r.date), blank: r.blank === true, missing: r.missing === true, review: r.review === true,
      parts: objs(r.parts).map((p) => keepRest({ name: str(p.name), rel: str(p.rel), url: str(p.url), from: count(p.from), to: count(p.to) }, p, READ.bundlePart, KIND.bundlePart)),
    }, r, READ.bundleRow, KIND.bundleRow));
    const name = str(x.name);
    return keepRest({
      no: str(x.no), name, slug: kebab(name), title: str(x.title), note: str(x.note), file: str(x.file), indexFile: str(x.indexFile), planFile: '',
      pages: count(x.pages), bundlePages: count(x.pages), filePages: count(x.filePages), indexPages: count(x.indexPages),
      nDocs: rows.length, nItems: rows.length, nMissing: rows.filter((r) => r.missing).length, nNeedsExtent: 0, nReview: rows.filter((r) => r.review).length,
      items: rows.map((r) => r.key), rows,
    }, x, READ.bundle, KIND.bundle);
  });
  const defaults = isObject(b.headerDefaults) ? b.headerDefaults : {};
  const sum = (f: 'nDocs' | 'nItems' | 'pages') => list.reduce((n, x) => n + x[f], 0);
  const out: JsonObject = {
    source: str(b.source), indexSource: str(b.indexSource), folder: str(b.folder), extracts: '', caselinesSrc: str(b.caselinesSrc),
    count: list.length, catCount: 0, totalDocs: sum('nDocs'), totalItems: sum('nItems'), totalPages: sum('pages'),
    headerDefaults: keepRest(Object.fromEntries(HEADER_KEYS.map((k) => [k, str(defaults[k])])), defaults, HEADER_KEYS), caselinesSections: {}, catalogue: {}, list,
  };
  return keepRest(out, b, READ.bundles, KIND.bundles);
}

const en = (n: number) => n.toLocaleString('en-US');

/** Reports the rows the export marks shortened (`sh` 1 or true); a flag that is neither 1 nor 0 is counted, never read as complete. */
function reportShortened(rows: readonly JsonObject[], sink: DiagSink): void {
  const shortened = rows.filter((r) => r.sh === 1 || r.sh === true).length;
  const unclear = rows.filter((r) => r.sh !== undefined && r.sh !== null && r.sh !== 0 && r.sh !== false && r.sh !== 1 && r.sh !== true).length;
  if (shortened === 0 && unclear === 0) return;
  sink.add('V5_TEXT_CAPPED', `${en(shortened)} of ${en(rows.length)} chronology rows are marked shortened (sh) by the export, which holds only part of their text`
    + (unclear ? `; ${en(unclear)} more ${unclear === 1 ? 'carries' : 'carry'} a sh value that is neither 1 nor 0 and could not be read` : ''), { file: 'input', subject: 'app-data.chronology' });
}

/** The top-level keys the mapping reads, and what each must be to be read; a key of another type stays beside the mapped datasets. `ft` is dropped on purpose, with its own diagnostic. */
const MAPPED_DATA_KEYS: Record<string, Kind | undefined> = { chronology: 'objs', people: 'objs', entities: 'objs', contradictions: 'objs', agreements: 'objs', bundles: 'object', meta: 'object', ft: undefined };
const MAPPED_SEED_KEYS: Record<string, Kind | undefined> = { client: 'str', matters: 'objs', risk: 'objs', vdm: 'objs', inforeq: 'objs', witnesses: 'objs', elements: 'objs', authorities: 'objs', discovery: 'objs' };

export function toV5Roots(appData: JsonObject, appSeed: JsonObject, sink: DiagSink): Partial<Record<V5Root, JsonValue>> {
  const rows = objs(appData.chronology).map(chronologyRow);
  reportShortened(objs(appData.chronology), sink);
  const rowsByRef = new Map(rows.map((r) => [str(r.ref), r]));
  const people = objs(appData.people).map(personOf);
  const DATA: JsonObject = { chronology: rows, people, entities: objs(appData.entities).map(entityOf), timeline: timelineOf(rows, rowsByRef, objs(appData.hot)) };
  const put = (key: string, v: JsonValue | undefined) => { if (v !== undefined) own(DATA, key, v); };
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
  if (isObject(appData.meta)) DATA.meta = appData.meta;
  for (const [from, mapped] of [[appData, MAPPED_DATA_KEYS], [appSeed, MAPPED_SEED_KEYS]] as const) {
    for (const [k, v] of Object.entries(from)) {
      const kind = Object.hasOwn(mapped, k) ? mapped[k] : null;
      if (kind === undefined || (kind !== null && fits(kind, v))) continue;
      ownOrAside(DATA, k, v);
    }
  }
  if (appData.ft !== undefined) sink.add('V5_SOURCE_INDEX_DROPPED', "app-data.ft is the viewer's full-text token index; not carried into the package (ClearCase indexes on its own)", { file: 'input', subject: 'app-data.ft' });
  const roots: Partial<Record<V5Root, JsonValue>> = { DATA, META: metaOf(isObject(appData.meta) ? appData.meta : {}, rows, people.length) };
  const sched = schedOf(objs(appSeed.discovery));
  if (sched) roots['window.__SCHED__'] = sched;
  return roots;
}
