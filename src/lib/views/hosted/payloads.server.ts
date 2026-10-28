// The hosted version pages' one read path (sprint ticket 06): authorize the case, check that the URL names its current
// published version and that the version is served from shards, then read a shard its publication admits. Authorization,
// the version check and the admitted names are one publication read (the reader authorizes it as it does getCase); no
// read model is loaded or hashed per request (the sign-off bound the manifests at publication, and upload checked the
// bytes). It runs once per request, however many loads ask.
import { error, type RequestEvent } from '@sveltejs/kit';
import type { CaseId, PublicationRecord, RequestServices, ResultsVersion } from '../../server/runtime/contracts.ts';
import { refuse } from '../../server/runtime/hosted/http.ts';
import { id } from '../../server/runtime/ids.ts';
import { VIEWS, type ViewEntry } from '../../components/view-registry.ts';
import type { ShardViewId, ViewShards } from '../payloads/views.ts';
import { hostedStatus } from './availability.ts';
import { caseHref } from './paths.ts';

const RV = /^sha256:[0-9a-f]{64}$/;
const PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
type Params = Partial<Record<string, string>>;

export interface PublishedVersion { caseId: CaseId; resultsVersion: ResultsVersion; publication: PublicationRecord; base: string }

/** The route base of a hosted case's version pages: `<base>/<rv>/overview`. */
export const versionBase = (caseId: string) => `${caseHref(caseId)}/v`;
const notFound = (): never => error(404, { message: 'Not found.', code: 'not-found' });

const memo = new WeakMap<RequestServices, Map<string, Promise<PublishedVersion>>>();

/** The case and its current published version named by `params`, or 404. A refusal of authority is a 404 too. */
export function publishedVersion(locals: RequestServices, params: Params): Promise<PublishedVersion> {
  const key = `${params.caseId ?? ''}\u0000${params.version ?? ''}`;
  let byKey = memo.get(locals);
  if (!byKey) memo.set(locals, (byKey = new Map()));
  let p = byKey.get(key);
  if (!p) { p = resolve(locals, params); byKey.set(key, p); }
  return p;
}

async function resolve(locals: RequestServices, params: Params): Promise<PublishedVersion> {
  const raw = params.caseId, rv = params.version;
  if (!raw || !PART.test(raw) || !rv || !RV.test(rv)) notFound();
  const caseId = id('case', raw!);
  const publication = await locals.store.publication({ caseId }).catch((e: unknown) => refuse(e));
  if (!publication || publication.versionId !== rv || !publication.shardManifestSha256 || !publication.shards) notFound();
  return { caseId, resultsVersion: rv as ResultsVersion, publication: publication!, base: versionBase(caseId) };
}

/**
 * One shard of the current published version, parsed. A name the publication does not admit is 404 before any cache or
 * R2 read; an admitted shard storage lacks, or holds with other bytes, is a 503.
 */
export async function shard<T>(locals: RequestServices, params: Params, name: string): Promise<T> {
  const v = await publishedVersion(locals, params);
  const admitted = v.publication.shards!;
  if (!Object.hasOwn(admitted, name)) notFound();
  const response = await locals.shards.read({ caseId: v.caseId, resultsVersion: v.resultsVersion, name, bytes: admitted[name]! }).catch((e: unknown) => refuse(e));
  if (!response) error(503, { message: 'The published results cannot be shown right now. Try again shortly.', code: 'storage-unavailable' });
  try { return JSON.parse(await response!.text()) as T; }
  catch { error(503, { message: 'The published results cannot be shown right now. Try again shortly.', code: 'invalid-package' }); }
}

/** The loader of a read-only dataset view: its shard, the route base and whether it has anything to show. */
export function datasetView<K extends ShardViewId>(id: K, isEmpty: (data: ViewShards[K]) => boolean) {
  return async ({ locals, params }: Pick<RequestEvent, 'locals' | 'params'>) => {
    const [data, v] = await Promise.all([shard<ViewShards[K]>(locals, params, `view/${id}.json`), publishedVersion(locals, params)]);
    return { ...data, base: v.base, empty: isEmpty(data) };
  };
}

/** A registry view that hosted shows as coming soon, by its route (`/analysis/matter`, `/chronology`); anything else is 404. */
export function comingSoon(route: string): { view: ViewEntry; status: 'soon' } {
  const view = VIEWS.find((v) => v.route === route);
  if (!view || hostedStatus(view.id) !== 'soon') notFound();
  return { view: view!, status: 'soon' };
}
