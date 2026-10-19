// TEST DOUBLE (hosted-gate profile only): see ./services.ts.
import type { AssetMetadata, AssetRef, AssetsAccess, ClientId, Identity } from '../../contracts.ts';
import { codeOf, contractError, isDenial } from '../../errors.ts';
import { digest } from '../../data.ts';
import { sha256 } from '../../ids.ts';
import { servePolicy } from '../../../../case-package/media.ts';
import type { D1, R2 } from '../bindings.ts';
import type { d1Audit } from './audit.ts';

type OriginalRow = { asset_id: string; object_key: string; size: number; sha256: string; media_type: string; filename: string };
const isUnavailable = (e: unknown) => codeOf(e) === 'missing-original' || codeOf(e) === 'changed-original';
const failed = (): never => {
	throw contractError('asset-unavailable', true);
};
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin' };

/**
 * Case originals from local R2, recorded in the fixture's D1 table, standing in for GRS-118. Every original is read
 * whole and checked against its recorded size and SHA-256 before a byte leaves, and the delivery is audited first.
 * Previews belong to a results version and stay unavailable.
 */
export function fixtureAssets(a: { db: D1; bucket: R2; clientId: ClientId; identity: Identity; audit: ReturnType<typeof d1Audit> }): AssetsAccess {
	const { db, bucket, clientId, audit } = a;
	const original = (asset: AssetRef) =>
		db.prepare('SELECT asset_id, object_key, size, sha256, media_type, filename FROM gate_original WHERE client_id = ? AND case_id = ? AND asset_id = ?').bind(clientId, asset.caseId, asset.assetId).first<OriginalRow>().catch(failed);
	const metadata = (r: OriginalRow): AssetMetadata => ({ size: r.size, sha256: sha256(r.sha256), mediaType: r.media_type, filename: r.filename, objectVersion: 'fixture-1', etag: `"${r.sha256.slice(0, 32)}"` });
	async function located(asset: AssetRef) {
		if (asset.kind !== 'original') throw contractError('asset-unavailable', true);
		await a.identity.authorize({ caseId: asset.caseId, operation: 'read-original' });
		const r = await original(asset);
		if (!r) throw contractError('not-found');
		return r;
	}
	async function read(asset: AssetRef) {
		const r = await located(asset);
		const object = await bucket.get(r.object_key).catch(failed);
		if (!object) throw contractError('missing-original');
		const bytes = new Uint8Array(await object.arrayBuffer());
		if (bytes.length !== r.size || (await digest(bytes)) !== r.sha256) throw contractError('changed-original');
		await a.identity.authorize({ caseId: asset.caseId, operation: 'read-original' }); // authority read again after the slow read
		return { bytes, metadata: metadata(r) };
	}
	// Metadata and links release no bytes but are still protected reads: a refusal appends its scoped denial.
	async function described<T>(asset: AssetRef, run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (e) {
			if (isDenial(e)) await audit.record({ action: 'asset.describe', object: { kind: 'asset', id: asset.assetId, caseId: asset.caseId }, version: null, outcome: 'denied' }).catch(() => undefined);
			throw e;
		}
	}
	return {
		async originals(scope) {
			await audit.authorized(scope, 'read-original', 'asset.list');
			const { results } = await db.prepare('SELECT asset_id, filename, media_type, size FROM gate_original WHERE client_id = ? AND case_id = ? ORDER BY asset_id').bind(clientId, scope.caseId).all<Omit<OriginalRow, 'object_key' | 'sha256'>>().catch(failed);
			return results.map((r) => ({ assetId: r.asset_id, filename: r.filename, mediaType: r.media_type, size: r.size }));
		},
		availability: ({ asset }) =>
			described(asset, async () => {
				try {
					return { kind: 'available', metadata: (await read(asset)).metadata };
				} catch (e) {
					const code = codeOf(e);
					if (code === 'missing-original' || code === 'changed-original') return { kind: 'unavailable', reason: code === 'missing-original' ? 'missing' : 'changed', parent: null };
					throw e;
				}
			}),
		metadata: ({ asset }) => described(asset, async () => metadata(await located(asset))),
		links: ({ asset }) =>
			described(asset, async () => {
				await located(asset);
				const href = `/cases/${encodeURIComponent(asset.caseId)}/originals/${encodeURIComponent(asset.assetId)}`;
				return { originalHref: href, downloadHref: `${href}?download=1`, viewerHref: null };
			}),
		async get({ asset, request }) {
			const object = { kind: 'asset', id: asset.assetId, caseId: asset.caseId };
			try {
				const { bytes, metadata: m } = await read(asset);
				// The bootstrap serves whole originals only; a range is refused rather than served from unchecked bytes. Nothing is
				// released, so the refusal is its own outcome and never a delivery.
				if (request.range && (request.ifRange === null || request.ifRange === m.etag)) {
					await audit.record({ action: 'asset.read-original', object, version: null, outcome: 'refused' }).catch(() => undefined);
					return new Response(null, { status: 416, headers: { ...HEADERS, 'content-range': `bytes */${bytes.length}` } });
				}
				// The delivery is recorded only when bytes are about to be released, and before any byte leaves; an unrecorded delivery is no delivery.
				try {
					await audit.record({ action: 'asset.read-original', object, version: null, outcome: 'succeeded' });
				} catch {
					return new Response(null, { status: 503, headers: { ...HEADERS, 'retry-after': '2' } });
				}
				const safe = new Headers(servePolicy(m.mediaType, m.filename).headers);
				for (const [name, value] of Object.entries(HEADERS)) safe.set(name, value);
				safe.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(m.filename)}`);
				safe.set('content-length', String(bytes.length));
				safe.set('etag', m.etag);
				return new Response(request.method === 'HEAD' ? null : bytes, { headers: safe });
			} catch (e) {
				if (isDenial(e)) await audit.record({ action: 'asset.read-original', object, version: null, outcome: 'denied' }).catch(() => undefined);
				// A missing or changed original is a failed read (the route answers it 410); the failure stands whether or not it is recorded.
				else if (isUnavailable(e)) await audit.record({ action: 'asset.read-original', object, version: null, outcome: 'failed' }).catch(() => undefined);
				throw e;
			}
		},
	};
}
