// The hosted gate's wrong-case and wrong-client original requests, through the real original route (serveAsset ->
// deliverAsset) over the gate doubles and a synthetic SQLite D1 (the stand-in gate-doubles.test.ts uses). test:hosted's
// denials leg requires the D1 audit log to name the refused request's own operation, `asset.read-original`, for these
// reads. The route asks `assets.metadata` first, so without a record under the requested operation the log holds
// only `asset.describe` and the leg fails on workerd. Synthetic fixture only; the workerd run stays the hosted evidence.
import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { RequestEvent } from '@sveltejs/kit';
import type { D1, D1Statement, R2 } from '../../../src/lib/server/runtime/hosted/bindings.ts';
import { gateServices } from '../../../src/lib/server/runtime/hosted/gate/services.ts';
import { serveAsset } from '../../../src/lib/viewer/hosted/route.ts';
import { deliverAsset } from '../../../src/lib/viewer/hosted/delivery.ts';
import type { AssetRef, AssetsAccess } from '../../../src/lib/server/runtime/contracts.ts';
import { gateFixture, sentinel } from './gate-fixture.ts';

function d1(db: DatabaseSync): D1 {
	const statement = (sql: string, values: (string | number | null)[] = []): D1Statement => ({
		bind: (...next) => statement(sql, next),
		first: async <T>() => (db.prepare(sql).get(...values) as T | undefined) ?? null,
		all: async <T>() => ({ results: db.prepare(sql).all(...values) as T[] }),
		run: async () => db.prepare(sql).run(...values),
	});
	return { prepare: (sql) => statement(sql), batch: async (all) => Promise.all(all.map((s) => s.run())) };
}

function world() {
	const fixture = gateFixture(), marker = sentinel('unit');
	const db = new DatabaseSync(':memory:');
	db.exec(marker.sql + '\n' + fixture.sql);
	const objects = new Map(fixture.objects.map((o) => [o.key, new Uint8Array(o.bytes)]));
	objects.set(marker.key, marker.bytes);
	const bucket: R2 = { get: async (key) => { const bytes = objects.get(key); return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } : null; } };
	const env = { DB: d1(db), BUCKET: bucket, ASSETS: { fetch() {} }, CLEARCASE_CLIENT_ID: 'client-a', CLEARCASE_GATE_RUN: 'unit', CLEARCASE_GATE_FIXTURE: fixture.sha256 };
	const session = (clientId: string, subject: string) => {
		const id = crypto.randomUUID();
		db.prepare("INSERT INTO gate_session (session_id, client_id, subject, kind, expires_at, revoked) VALUES (?, ?, ?, 'client', '2999-01-01T00:00:00.000Z', 0)").run(id, clientId, subject);
		return id;
	};
	// One GET of /cases/<caseId>/originals/<assetId> as the route handler receives it; the answer is its HTTP status and body.
	async function original(sessionId: string, caseId: string, assetId: string) {
		const request = new Request(`http://127.0.0.1/cases/${caseId}/originals/${assetId}`, { headers: { cookie: `clearcase_session=${sessionId}` } });
		const ready = await gateServices(request, env);
		if (!ready.ready) throw new Error(ready.reason);
		const event = { params: { caseId, assetId }, locals: ready.services, url: new URL(request.url), request } as unknown as RequestEvent;
		try {
			const r = await serveAsset(event, 'original', 'GET');
			return { status: r.status, text: await r.text() };
		} catch (e) {
			const status = (e as { status?: number }).status;
			if (typeof status !== 'number') throw e;
			return { status, text: JSON.stringify((e as { body?: unknown }).body ?? '') };
		}
	}
	// The gate's real AssetsAccess for one session, to call a handle or deliverAsset directly.
	async function assets(sessionId: string) {
		const ready = await gateServices(new Request('http://127.0.0.1/', { headers: { cookie: `clearcase_session=${sessionId}` } }), env);
		if (!ready.ready) throw new Error(ready.reason);
		return ready.services.assets;
	}
	const events = () => db.prepare('SELECT action, outcome, object_id FROM audit_event').all() as { action: string; outcome: string; object_id: string }[];
	return { session, original, assets, events };
}

describe('the original route audits a refused read under the operation requested (the test:hosted denials leg)', () => {
	it('records asset.read-original denied for a wrong-case original, answers 404 and releases no byte', async () => {
		const w = world();
		const r = await w.original(w.session('client-a', 'a-viewer'), 'case-a2', 'a2-statement');
		expect(r.status).toBe(404);
		expect(r.text).not.toContain('Synthetic');
		expect(w.events()).toContainEqual({ action: 'asset.read-original', outcome: 'denied', object_id: 'a2-statement' });
		expect(w.events().some((e) => e.outcome === 'succeeded')).toBe(false);
	});
	it('records asset.read-original denied for a wrong-client original, answers 401 and releases no byte', async () => {
		const w = world();
		const r = await w.original(w.session('client-b', 'b-editor'), 'case-b1', 'b1-letter');
		expect(r.status).toBe(401);
		expect(r.text).not.toContain('Synthetic');
		expect(w.events()).toContainEqual({ action: 'asset.read-original', outcome: 'denied', object_id: 'b1-letter' });
		expect(w.events().some((e) => e.outcome === 'succeeded')).toBe(false);
	});
	it('still audits the granted original as a single succeeded delivery', async () => {
		const w = world();
		const r = await w.original(w.session('client-a', 'a-viewer'), 'case-a1', 'a1-letter');
		expect(r.status).toBe(200);
		expect(w.events().filter((e) => e.outcome === 'succeeded')).toEqual([{ action: 'asset.read-original', outcome: 'succeeded', object_id: 'a1-letter' }]);
	});
});

const asset = (caseId: string, assetId: string) => ({ kind: 'original' as const, caseId, assetId }) as AssetRef;
const GET = { method: 'GET' as const, url: new URL('http://127.0.0.1/x'), headers: new Headers() };

describe('metadata names the read it prefaces (the optional for: "read" intent)', () => {
	it('keeps asset.describe for a refused metadata call that names no intent', async () => {
		const w = world(), a = await w.assets(w.session('client-a', 'a-viewer'));
		await expect(a.metadata({ asset: asset('case-a2', 'a2-statement') })).rejects.toMatchObject({ code: 'forbidden' });
		expect(w.events()).toContainEqual({ action: 'asset.describe', outcome: 'denied', object_id: 'a2-statement' });
		expect(w.events().some((e) => e.action === 'asset.read-original')).toBe(false);
	});
	it('audits a refused for: "read" call once under asset.read-original, never as asset.describe', async () => {
		const w = world(), a = await w.assets(w.session('client-a', 'a-viewer'));
		await expect(a.metadata({ asset: asset('case-a2', 'a2-statement'), for: 'read' })).rejects.toMatchObject({ code: 'forbidden' });
		expect(w.events().filter((e) => e.object_id === 'a2-statement')).toEqual([{ action: 'asset.read-original', outcome: 'denied', object_id: 'a2-statement' }]);
	});
	it('records nothing for a granted for: "read" call: the delivery is recorded only by get', async () => {
		const w = world(), a = await w.assets(w.session('client-a', 'a-viewer'));
		expect((await a.metadata({ asset: asset('case-a1', 'a1-letter'), for: 'read' })).filename).toBeTruthy();
		expect(w.events()).toEqual([]);
	});
	it('stops deliverAsset at a refused preflight: one requested-read denial, no get, no success, though get would permit', async () => {
		const w = world(), real = await w.assets(w.session('client-a', 'a-viewer'));
		const permissive = vi.fn(async () => new Response('LEAKED', { status: 200 }));
		const guarded: AssetsAccess = { ...real, get: permissive };
		await expect(deliverAsset({ assets: guarded, asset: asset('case-a2', 'a2-statement'), ...GET })).rejects.toMatchObject({ code: 'forbidden' });
		expect(permissive).not.toHaveBeenCalled();
		expect(w.events()).toEqual([{ action: 'asset.read-original', outcome: 'denied', object_id: 'a2-statement' }]);
	});
	it('passes the read intent to the preflight and keeps the not-found status without reaching get', async () => {
		const get = vi.fn(), metadata = vi.fn(async () => { throw Object.assign(new Error('gone'), { code: 'not-found' }); });
		const stub = { metadata, get } as unknown as AssetsAccess;
		const ref = asset('case-a1', 'a1-letter');
		await expect(deliverAsset({ assets: stub, asset: ref, ...GET })).rejects.toMatchObject({ code: 'not-found' });
		expect(metadata).toHaveBeenCalledExactlyOnceWith({ asset: ref, for: 'read' });
		expect(get).not.toHaveBeenCalled();
	});
});
