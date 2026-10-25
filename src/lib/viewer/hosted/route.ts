// The two hosted routes that release protected bytes share this one handler: an original (case-level, reachable through
// the case grant alone) and a derived preview (reachable only while its exact results version is published).
import { error, type RequestEvent } from '@sveltejs/kit';
import { refuse } from '../../server/runtime/hosted/http.ts';
import { id, resultsVersion } from '../../server/runtime/ids.ts';
import type { AssetRef } from '../../server/runtime/contracts.ts';
import { deliverAsset } from './delivery.ts';

const PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const absent = () => error(404, { message: 'Not found.', code: 'not-found' });

/** The asset a request's URL names, or a 404: a malformed id is absence, never a probe of storage. */
export function assetRefOf(kind: 'original' | 'preview', params: Record<string, string | undefined>): AssetRef {
  const { caseId, assetId, version } = params;
  if (!caseId || !assetId || !PART.test(caseId) || !PART.test(assetId)) absent();
  if (kind === 'original') return { kind, caseId: id('case', caseId!), assetId: assetId! };
  let rv;
  try { rv = resultsVersion(version ?? ''); } catch { absent(); }
  return { kind, caseId: id('case', caseId!), resultsVersion: rv!, assetId: assetId! };
}

export function serveAsset(event: RequestEvent, kind: 'original' | 'preview', method: 'GET' | 'HEAD'): Promise<Response> {
  const asset = assetRefOf(kind, event.params as Record<string, string | undefined>);
  return deliverAsset({ assets: event.locals.assets, asset, method, url: event.url, headers: event.request.headers }).catch((e) => refuse(e));
}
