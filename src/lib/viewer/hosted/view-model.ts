import { env } from 'cloudflare:workers';
import { fastOriginals } from './fast-original';
import { mintTicket } from './ticket';
import { codeOf } from '../../server/runtime/errors';
// What the viewer page shows for one original, decided from the assets handle's own answers. The page never receives an
// object key, a storage id or the content hash: its links are the case/asset routes only.
import type { AssetAvailability, AssetsAccess, CaseId } from '../../server/runtime/contracts.ts';
import { servePolicy } from '../../case-package/media.ts';

export type ViewMode = 'pdf' | 'image' | 'email' | 'download';
export type OriginalView =
  | { state: 'available'; mode: ViewMode; filename: string; mediaType: string; size: number; srcHref: string; downloadHref: string }
  | { state: 'unavailable'; reason: 'missing' | 'changed' | 'embedded'; filename: string | null };

/** In-app only for what the viewer renders natively (PDF, common images); everything else offers the unchanged original as a download. */
export function modeFor(mediaType: string, filename: string): ViewMode {
  if (servePolicy(mediaType, filename).mode !== 'inline-isolated') return 'download';
  return mediaType === 'application/pdf' ? 'pdf' : mediaType.startsWith('image/') ? 'image' : 'download';
}

export async function originalView(a: { assets: AssetsAccess; caseId: CaseId; assetId: string }): Promise<OriginalView> {
  const asset = { kind: 'original' as const, caseId: a.caseId, assetId: a.assetId };
  const fast = fastOriginals(a.assets);
  if (fast) {
    try {
      const row = await fast.locate(asset);
      const {objectKey: _objectKey, ...claims} = row;
      const ticket = await mintTicket(claims,String(env.CLEARCASE_ASSET_TICKET_KEY ?? ''));
      const base = `/cases/${encodeURIComponent(a.caseId)}/originals/${encodeURIComponent(a.assetId)}`;
      return {state:'available',mode:row.mediaFamily === 'email-text' && row.mediaType === 'message/rfc822' ? 'email' : modeFor(row.mediaType,row.filename),filename:row.filename,mediaType:row.mediaType,size:row.size,srcHref:`${base}?t=${encodeURIComponent(ticket)}`,downloadHref:`${base}?download=1`};
    } catch (e) { if (codeOf(e) === 'not-found' || codeOf(e) === 'missing-original') return {state:'unavailable',reason:'missing',filename:null}; throw e; }
  }
  // Metadata and the links first: both are authorized, byte-free reads, so an inaccessible original reads as absent before the verified read.
  const [metadata, links] = await Promise.all([a.assets.metadata({ asset }), a.assets.links({ asset })]);
  const availability: AssetAvailability = await a.assets.availability({ asset });
  if (availability.kind === 'unavailable') return { state: 'unavailable', reason: availability.reason, filename: metadata.filename };
  return {
    state: 'available', mode: modeFor(metadata.mediaType, metadata.filename), filename: metadata.filename, mediaType: metadata.mediaType, size: metadata.size,
    srcHref: links.originalHref, downloadHref: links.downloadHref,
  };
}
