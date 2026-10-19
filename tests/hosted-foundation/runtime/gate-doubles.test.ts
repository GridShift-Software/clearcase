// The hosted-gate doubles over a D1 stand-in (node:sqlite behind D1's prepare/bind/first/all/run) and an R2 stand-in,
// seeded with the same synthetic fixture start:hosted provisions. The workerd run (test:hosted) is the hosted evidence;
// these cover the failure paths a running Worker cannot be pushed into: audit persistence failing, an original changed
// under its recorded digest, and authority withdrawn between authorization and release.
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { D1, D1Statement, R2 } from '../../../src/lib/server/runtime/hosted/bindings.ts';
import { gateServices } from '../../../src/lib/server/runtime/hosted/gate/services.ts';
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
	const services = async (sessionId: string | null) => {
		const r = await gateServices(new Request('http://127.0.0.1/', { headers: sessionId ? { cookie: `clearcase_session=${sessionId}` } : {} }), env);
		if (!r.ready) throw new Error(r.reason);
		return r.services;
	};
	const events = () => db.prepare('SELECT action, outcome, object_id FROM audit_event').all() as { action: string; outcome: string; object_id: string }[];
	return { db, objects, session, services, events };
}
const original = { kind: 'original' as const, caseId: 'case-a1' as never, assetId: 'a1-letter' };
const get = { method: 'GET' as const, range: null, ifRange: null };

describe('hosted-gate doubles (denial without an audit event, range or release before integrity)', () => {
	it('releases an original only after its success event is persisted: an audit failure is 503 with no bytes', async () => {
		const w = world(), s = await w.services(w.session('client-a', 'a-viewer'));
		w.db.exec('DROP TABLE audit_event');
		const r = await s.assets.get({ asset: original, request: get });
		expect([r.status, r.body, r.headers.get('retry-after')]).toEqual([503, null, '2']);
	});
	it('refuses an original changed under its recorded size and digest before any byte, with no success event', async () => {
		const w = world(), s = await w.services(w.session('client-a', 'a-viewer'));
		const bytes = w.objects.get('originals/client-a/case-a1/a1-letter')!;
		bytes[bytes.length - 1] ^= 1; // same size, one byte off
		await expect(s.assets.get({ asset: original, request: { ...get, range: 'bytes=0-63' } })).rejects.toMatchObject({ code: 'changed-original' });
		expect(w.events().filter((e) => e.outcome === 'succeeded')).toEqual([]);
	});
	it('audits a refused Range as refused, never as a delivery, and still serves a whole read when If-Range does not match', async () => {
		const w = world(), s = await w.services(w.session('client-a', 'a-viewer'));
		const refused = await s.assets.get({ asset: original, request: { ...get, range: 'bytes=0-3' } });
		expect([refused.status, refused.body]).toEqual([416, null]);
		expect(w.events()).toEqual([{ action: 'asset.read-original', outcome: 'refused', object_id: 'a1-letter' }]);
		const whole = await s.assets.get({ asset: original, request: { ...get, range: 'bytes=0-3', ifRange: '"old"' } });
		expect(whole.status).toBe(200);
		expect(w.events().map((e) => e.outcome)).toEqual(['refused', 'succeeded']);
	});
	it('appends a failed event when an original is missing or changed, and none as a success', async () => {
		const w = world(), s = await w.services(w.session('client-a', 'a-viewer')), key = 'originals/client-a/case-a1/a1-letter';
		const bytes = w.objects.get(key)!;
		bytes[0] ^= 1;
		await expect(s.assets.get({ asset: original, request: get })).rejects.toMatchObject({ code: 'changed-original' });
		w.objects.delete(key);
		await expect(s.assets.get({ asset: original, request: get })).rejects.toMatchObject({ code: 'missing-original' });
		expect(w.events()).toEqual([
			{ action: 'asset.read-original', outcome: 'failed', object_id: 'a1-letter' },
			{ action: 'asset.read-original', outcome: 'failed', object_id: 'a1-letter' },
		]);
	});
	it('records a scoped denial for a wrong-client session, an anonymous request and a wrong-case read', async () => {
		const w = world();
		await expect((await w.services(w.session('client-b', 'b-editor'))).assets.get({ asset: original, request: get })).rejects.toMatchObject({ code: 'wrong-client' });
		await expect((await w.services(null)).store.getCase({ caseId: 'case-a1' as never })).rejects.toMatchObject({ code: 'unauthenticated' });
		await expect((await w.services(w.session('client-a', 'a-viewer'))).assets.originals({ caseId: 'case-a2' as never })).rejects.toMatchObject({ code: 'forbidden' });
		expect(w.events()).toEqual([
			{ action: 'asset.read-original', outcome: 'denied', object_id: 'a1-letter' },
			{ action: 'case.read', outcome: 'denied', object_id: 'case-a1' },
			{ action: 'asset.list', outcome: 'denied', object_id: 'case-a2' },
		]);
	});
	it('reads the grant again before release: a grant withdrawn during the read releases nothing', async () => {
		const w = world(), s = await w.services(w.session('client-a', 'a-viewer'));
		const key = 'originals/client-a/case-a1/a1-letter', real = w.objects.get.bind(w.objects);
		// the grant is withdrawn while the object is read, after the first authorization
		w.objects.get = (k: string) => { if (k === key) w.db.prepare("DELETE FROM gate_grant WHERE subject = 'a-viewer'").run(); return real(k); };
		await expect(s.assets.get({ asset: original, request: get })).rejects.toMatchObject({ code: 'forbidden' });
		expect(w.events()).toEqual([{ action: 'asset.read-original', outcome: 'denied', object_id: 'a1-letter' }]);
	});
	it('signs out at once: a revoked session is invalid on its next check', async () => {
		const w = world(), id = w.session('client-a', 'a-viewer'), s = await w.services(id);
		await s.runtime.testIdentity!.signOut({ sessionId: id as never });
		await expect(s.store.listCases()).rejects.toMatchObject({ code: 'invalid-session' });
	});
});
