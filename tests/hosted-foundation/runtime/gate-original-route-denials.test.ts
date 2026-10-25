// The hosted gate's wrong-case and wrong-client original requests, through the real original route (serveAsset ->
// deliverAsset) over the gate doubles and a synthetic SQLite D1 (the stand-in gate-doubles.test.ts uses). test:hosted's
// denials leg requires the D1 audit log to name the refused request's own operation, `asset.read-original`, for these
// reads. The route asks `assets.metadata` first, so without a record under the requested operation the log holds
// only `asset.describe` and the leg fails on workerd. Synthetic fixture only; the workerd run stays the hosted evidence.
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { RequestEvent } from '@sveltejs/kit';
import type { D1, D1Statement, R2 } from '../../../src/lib/server/runtime/hosted/bindings.ts';
import { gateServices } from '../../../src/lib/server/runtime/hosted/gate/services.ts';
import { serveAsset } from '../../../src/lib/viewer/hosted/route.ts';
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
	const events = () => db.prepare('SELECT action, outcome, object_id FROM audit_event').all() as { action: string; outcome: string; object_id: string }[];
	return { session, original, events };
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
