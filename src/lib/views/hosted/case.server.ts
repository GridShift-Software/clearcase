// The hosted case pages' reads, over the request's RequestServices only (no local case store, no fixture). The case is
// read first through the authorized case read (store.getCase), and nothing else is asked for before it answers. Results
// show only for the case's current published version, and only when the store names that same version active and it
// passes its integrity check; anything else is a designed waiting, withdrawn or unavailable state, never stale content.
// A denial anywhere fails the page through refuse(); a fault in one part shows that part unavailable.
import { error } from '@sveltejs/kit';
import type { CaseId, CaseInfo, ChronologyListRow, OverviewModel, RequestServices, ResultsStatus, ResultsVersion, ViewContentReader } from './types.ts';
import type { ChronologyData, ChronologyItem, OverviewData } from './model.ts';
import { refuse } from '../../server/runtime/hosted/http.ts';
import { codeOf, isDenial } from '../../server/runtime/errors.ts';
import { id } from '../../server/runtime/ids.ts';
import { paramsFromQuery, queryFromParams, queryRows, optionsOf, statusOptions } from '../../local-case/chronology.ts';
import { chronologyHref, notesHref, originalHref } from './paths.ts';
import { originalAttributions, publishedReadiness } from '../../results/hosted/published-reads.ts';

const PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RV = /^sha256:[0-9a-f]{64}$/;

export type Part<T> = { state: 'available'; value: T } | { state: 'unavailable'; code: string };
/** A fault becomes the part's unavailable state; a denial is rethrown as the page's refusal. */
export const part = <T>(work: Promise<T>): Promise<Part<T>> =>
  work.then((value) => ({ state: 'available' as const, value }), (e: unknown) => (isDenial(e) ? refuse(e) : { state: 'unavailable' as const, code: codeOf(e) ?? 'error' }));

const notFound = (): never => error(404, { message: 'Not found.', code: 'not-found' });

/** The authorized case read: the case id from the URL, checked, then store.getCase; a missing case is 404. */
export async function readCase(services: RequestServices, raw: string | undefined): Promise<{ caseId: CaseId; info: CaseInfo }> {
  if (!raw || !PART.test(raw)) notFound();
  const caseId = id('case', raw!);
  const info = await services.store.getCase({ caseId }).catch((e) => refuse(e));
  if (!info) notFound();
  return { caseId, info: info! };
}

/**
 * Whether the page shows its write controls, asked after the page's authorized read: the request's case snapshot says the
 * signed-in person's grant writes user work, at no further query. A runtime without that snapshot keeps the controls; every
 * write is authorized on its own either way, so this only spares a viewer controls that would be refused.
 */
export async function canWriteWork(services: RequestServices, caseId: CaseId): Promise<boolean> {
  return services.canWriteWork ? services.canWriteWork({ caseId }) : true;
}

export type Current = { kind: 'current'; resultsVersion: ResultsVersion } | { kind: 'status'; status: ResultsStatus };
const UNAVAILABLE = 'The published results cannot be shown right now. Try again shortly.';

/** The version the case's results come from, or why there are none. Only the current published version qualifies. */
export async function currentVersion(services: RequestServices, info: CaseInfo): Promise<Current> {
  const p = info.publication;
  if (p.kind !== 'published') return { kind: 'status', status: { kind: p.kind === 'none' ? 'pending' : 'withdrawn' } };
  const scope = { caseId: info.caseId, resultsVersion: p.resultsVersion };
  if (services.caseRead) {
    const memo = await services.caseRead({ caseId: info.caseId });
    if (memo.published?.shardManifestSha256) return memo.published.versionId === p.resultsVersion ? { kind: 'current', resultsVersion: p.resultsVersion } : { kind: 'status', status: { kind: 'unavailable', reason: UNAVAILABLE } };
  }
  const active = await part(services.store.activeVersionId({ caseId: info.caseId }));
  if (active.state === 'unavailable' || active.value !== p.resultsVersion) return { kind: 'status', status: { kind: 'unavailable', reason: UNAVAILABLE } };
  const check = await part(publishedReadiness(services.store, scope));
  if (check.state === 'unavailable') return { kind: 'status', status: { kind: 'unavailable', reason: check.code === 'integrity' ? 'The published results failed their integrity check, so they are not shown.' : UNAVAILABLE } };
  return { kind: 'current', resultsVersion: p.resultsVersion };
}

/** A version route's version: the URL must name the case's current published version, or the page does not exist. */
export async function requireCurrent(services: RequestServices, info: CaseInfo, raw: string | undefined): Promise<ResultsVersion> {
  if (!raw || !RV.test(raw)) notFound();
  if (info.publication.kind !== 'published' || info.publication.resultsVersion !== raw) notFound();
  const current = await currentVersion(services, info);
  if (current.kind !== 'current') error(503, { message: current.status.kind === 'unavailable' ? current.status.reason : UNAVAILABLE, code: 'storage-unavailable' });
  return (current as { resultsVersion: ResultsVersion }).resultsVersion;
}

function viewText(vc: ViewContentReader, view: string, field: string, params: Readonly<Record<string, string | number>>): string | null {
  const f = vc.fill(view, field, params);
  return f && f.missing.length === 0 && f.text.trim() ? f.text : null;
}
const entries = <T>(m: Record<string, T>): [string, T][] => Object.entries(m);

/** The overview of the current published version: the stored overview model, the store's derived counts, view content. */
export async function overviewOf(services: RequestServices, caseId: CaseId, resultsVersion: ResultsVersion, label: string): Promise<OverviewData | null> {
  const scope = { caseId, resultsVersion };
  const [version, documents, vc] = await Promise.all([services.store.getVersion({ resultsVersion }), services.store.documentCounts(scope), services.store.viewContentOf(scope)]);
  if (!version || version.case_id !== caseId) return null;
  const o = JSON.parse(version.overview) as OverviewModel;
  const caseName = o.caseLabel || label;
  const params = { docCount: documents.total, bundleCount: Object.keys(o.counts.byBundle).length, invoiceCount: o.quantum?.invoiceCount ?? o.counts.invoices, caseName };
  return {
    resultsVersion, caseName, subtitle: viewText(vc, 'overview', 'subtitle', params), matterTitle: o.matter?.title || null, producer: o.producer, created: o.created, inputKind: o.inputKind,
    documents: { total: documents.total, imported: documents.imported, provided: documents.provided, failed: documents.failed.map((f) => ({ source: f.source, owner: f.owner, reason: f.reason })) },
    counts: { emails: o.counts.emails, invoices: o.counts.invoices, attachments: o.counts.attachments, withoutText: o.counts.byTextStatus.none ?? 0 },
    dates: o.dates, originals: o.originals,
    // dataset names (bundles, types) never become object keys in page data
    tallies: { byBundle: entries(o.counts.byBundle), byDocType: entries(o.counts.byDocType), byTextStatus: entries(o.counts.byTextStatus) },
    chronologyHref: chronologyHref(caseId, resultsVersion), notesHref: notesHref(caseId),
  };
}

const isRow = (r: unknown): r is ChronologyListRow => !!r && typeof r === 'object' && typeof (r as ChronologyListRow).ref === 'string' && typeof (r as ChronologyListRow).ord === 'number';

/** The chronology of the current published version, filtered and sorted with the local view's own query semantics. */
export async function chronologyOf(services: RequestServices, caseId: CaseId, resultsVersion: ResultsVersion, search: URLSearchParams): Promise<ChronologyData> {
  const scope = { caseId, resultsVersion };
  const [list, originals, attribution] = await Promise.all([services.store.listJson(scope), part(services.assets.originals({ caseId })), part(originalAttributions(services.store, scope))]);
  if (!list) error(503, { message: UNAVAILABLE, code: 'storage-unavailable' });
  const parsed: unknown = JSON.parse(list!.json);
  if (!Array.isArray(parsed) || !parsed.every(isRow)) error(503, { message: UNAVAILABLE, code: 'invalid-package' });
  const rows = parsed as ChronologyListRow[];
  const query = queryFromParams(search);
  const assets = new Set(originals.state === 'available' ? originals.value.map((o) => o.assetId) : []);
  const mapped = new Map(attribution.state === 'available' ? attribution.value.filter((a) => assets.has(a.assetId)).map((a) => [a.ref, a.assetId]) : []);
  const items = queryRows(rows, query).map((r): ChronologyItem => ({
    ref: r.ref, date: r.date, docType: r.docType, bundle: r.bundle, title: r.subject || r.filename, sender: r.sender, excerpt: r.excerpt, amount: r.amount, textStatus: r.textStatus, parentRef: r.parentRef, file: r.file,
    originalHref: r.file === 'present' && mapped.has(r.ref) ? originalHref(caseId, mapped.get(r.ref)!) : null,
    originalAssetId: r.file === 'present' ? mapped.get(r.ref) ?? null : null,
  }));
  return {
    resultsVersion, total: rows.length, items, query, search: paramsFromQuery(query).toString(),
    options: { bundles: optionsOf(rows, 'bundle'), types: optionsOf(rows, 'docType'), statuses: statusOptions(rows) },
    failed: list!.failed.map((f) => ({ source: f.source, owner: f.owner, reason: f.reason })), originals: originals.state === 'available' && attribution.state === 'available' ? 'available' : 'unavailable',
  };
}

export type { ChronologyData, ChronologyItem, OverviewData };
