// The recovery probe's Worker (GRS-110): GRS-109's storage Worker, imported whole and unchanged, behind the recovery and
// deletion contracts. Every request first passes the storage Worker's own identity gate (GET /identity) and a check that
// the RECOVERY bucket belongs to the same client; whatever this module does not route goes to the storage Worker as is.
//
// What it adds:
// - a case's deletion: a firm admin requests it, a Global Admin approves it and offers the case's export, then the Global
//   Admin removes it, which erases the case's live rows and objects and leaves only the deletion state in D1;
// - deletion records: written to the live bucket and to RECOVERY before the erasure, and reapplied on every restore. A
//   copy or packet of a deleted case is refused, and a D1 database rolled back to before a removal, or a fresh deployment
//   that never saw it, is brought back in line before it serves anything (reconcile);
// - rolling recovery copies: a sealed case backup copied into RECOVERY, staged back into the live bucket for GRS-109's
//   restore path (tagged with its case, deleted when its restore finishes, swept by the case's removal), and rotated by age
//   (30 days) without touching live data or bundle history; rotation also ages out restore packets that name no case;
// - bundle history, a stand-in for GRS-128's PDF bundle versions, so rotation can be shown to leave it alone.
import storage from '../../storage/src/worker.ts';
import { type D1, type D1Value, type Env, type R2, type R2Object, type R2ObjectBody, fixedLength, hasBody, hex, sha256Hex } from '../../storage/src/platform.ts';

class Refused extends Error {
	readonly status: number;
	readonly code: string;
	readonly detail: Record<string, unknown>;
	constructor(status: number, code: string, detail: Record<string, unknown> = {}) {
		super(code);
		this.status = status;
		this.code = code;
		this.detail = detail;
	}
}
const refuse = (status: number, code: string, detail: Record<string, unknown> = {}): never => {
	throw new Refused(status, code, detail);
};
class GuardFailed extends Error {}

type Row = Record<string, unknown>;
type RecoveryEnv = Env & { RECOVERY?: unknown };
type Ctx = { client: string; db: D1; bucket: R2; copies: R2; env: RecoveryEnv };
/** What R2's list and head return beyond platform.ts's shape: the time R2 stored the object, which is what rotation ages. */
type Stored = R2Object & { uploaded: Date };

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f-]{36}$/;
const SHA = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Separation of duties: who may take each step of a deletion. Authentication itself is GRS-108 and GRS-113's. */
const ROLE = { request: 'firm-admin', approve: 'global-admin', offer: 'global-admin', remove: 'global-admin' } as const;
type Step = keyof typeof ROLE;

const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, 'content-type': 'application/json' } });
const isObject = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (re: RegExp) => (v: unknown): v is string => typeof v === 'string' && re.test(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
function field<T>(o: Row, name: string, ok: (v: unknown) => v is T): T {
	return ok(o[name]) ? (o[name] as T) : refuse(400, 'invalid-field', { field: name });
}
async function body(request: Request): Promise<Row> {
	const value = await request.json().catch(() => refuse(400, 'invalid-json'));
	return isObject(value) ? value : refuse(400, 'invalid-json');
}
const isBinding = (v: unknown, ...methods: string[]) => typeof v === 'object' && v !== null && methods.every((m) => typeof (v as Row)[m] === 'function');

/** A request to the storage Worker from inside this one: same bindings, same gate. */
const inner = (env: RecoveryEnv, path: string, init?: RequestInit) => storage.fetch(new Request(`http://storage${path}`, init), env);

async function all<T = Row>(db: D1, text: string, ...params: D1Value[]): Promise<T[]> {
	return (await db.prepare(text).bind(...params).all<T>()).results;
}
async function first<T = Row>(db: D1, text: string, ...params: D1Value[]): Promise<T | null> {
	return (await all<T>(db, text, ...params))[0] ?? null;
}
/** A batch whose first statement fails, rolling the batch back, unless `condition` holds (GRS-109's batch_guard). */
async function guarded(db: D1, condition: string, params: D1Value[], statements: [string, D1Value[]][]) {
	try {
		await db.batch([[`INSERT INTO batch_guard (token) SELECT CASE WHEN ${condition} THEN 'ok' END`, params] as [string, D1Value[]], ...statements, ['DELETE FROM batch_guard', []] as [string, D1Value[]]].map(([t, p]) => db.prepare(t).bind(...p)));
	} catch (e) {
		if (String(e).includes('batch_guard.token')) throw new GuardFailed();
		throw e;
	}
}

let recoveryClient: string | null = null; // per isolate, as the storage Worker caches its verified client

async function open(env: RecoveryEnv): Promise<Ctx | Response> {
	const identity = await inner(env, '/identity');
	if (identity.status !== 200) return identity; // the storage gate's own refusal (503), passed on unchanged
	const client = ((await identity.json()) as { client: string }).client;
	if (!isBinding(env.RECOVERY, 'get', 'put', 'head', 'list', 'delete')) refuse(503, 'missing-binding', { binding: 'RECOVERY' });
	const ctx: Ctx = { client, db: env.DB as D1, bucket: env.BUCKET as R2, copies: env.RECOVERY as R2, env };
	if (recoveryClient !== client) {
		// The other client's identifier is never echoed, as in the storage gate.
		const object = await ctx.copies.get('identity/client.json');
		let held: unknown = null;
		if (hasBody(object)) held = await object.text().then((t) => (JSON.parse(t) as Row).client_id, () => null);
		if (typeof held !== 'string' || !held) refuse(503, 'missing-identity', { binding: 'RECOVERY' });
		if (held !== client) refuse(503, 'crossed-binding', { binding: 'RECOVERY' });
		recoveryClient = client;
	}
	// One D1 statement a request: a database holding fewer removed cases than the ledger was rolled back (D1 Time Travel)
	// or is new; one holding more was written by another isolate. Either way the ledger is read again and applied.
	const removed = (await first<{ n: number }>(ctx.db, "SELECT count(*) AS n FROM case_deletion WHERE state = 'removed'"))!.n;
	if (ledgerSize === null || removed !== ledgerSize) await reconcile(ctx);
	return ctx;
}

// ----- deletion -----

type Deletion = { case_id: string; state: 'requested' | 'approved' | 'offered' | 'removed'; requested_by: string; requested_at: string; approved_by: string | null; approved_at: string | null; export_id: string | null; export_sha256: string | null; export_size: number | null; offered_at: string | null; removed_by: string | null; removed_at: string | null; erase_plan: string | null };
const deletionOf = (ctx: Ctx, caseId: string) => first<Deletion>(ctx.db, 'SELECT * FROM case_deletion WHERE case_id = ?', caseId);

function actor(b: Row, step: Step): string {
	const a = field(b, 'actor', isObject);
	const role = field(a, 'role', isText(/^[a-z-]{1,40}$/));
	const id = field(a, 'id', isText(ID));
	if (role !== ROLE[step]) refuse(403, 'wrong-role', { step, required: ROLE[step] });
	return `${role}:${id}`;
}

/** The tables that hold a case's rows, read from sqlite_master, never from a list written here. */
async function catalog(ctx: Ctx) {
	// case_deletion is the one case table a removal keeps: it is the record of the removal.
	const cols = await all<{ t: string; c: string }>(ctx.db, "SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name <> 'case_deletion' AND p.name IN ('case_id', 'version_id', 'export_id') AND m.name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY m.name");
	const by = (c: string) => new Set(cols.filter((x) => x.c === c).map((x) => x.t));
	const caseT = by('case_id');
	const versionT = [...by('version_id')].filter((t) => !caseT.has(t));
	const exportT = [...by('export_id')].filter((t) => !caseT.has(t));
	// Children before their parents: results_version and export_job are referenced by rows in the other tables.
	const parents = ['export_job', 'results_version'].filter((t) => caseT.has(t));
	return { versionT, exportT, caseT: [...caseT].filter((t) => !parents.includes(t)), parents };
}

type Plan = { versions: string[]; exports: string[]; originals: string[] };
const union = (a: string[], b: string[]) => [...new Set([...a, ...b])].sort();

/** Removes every live row and object of the case, keeping its case_deletion row as `removed`. Safe to repeat. */
async function erase(ctx: Ctx, caseId: string, set: [string, D1Value[]], condition: [string, D1Value[]]) {
	const prior = (await deletionOf(ctx, caseId))?.erase_plan;
	const found: Plan = {
		versions: (await all<{ v: string }>(ctx.db, 'SELECT version_id AS v FROM results_version WHERE case_id = ?', caseId)).map((r) => r.v),
		exports: (await all<{ e: string }>(ctx.db, 'SELECT export_id AS e FROM export_job WHERE case_id = ?', caseId)).map((r) => r.e),
		// An original another case also records stays: originals are content-addressed and shared.
		originals: (await all<{ s: string }>(ctx.db, 'SELECT DISTINCT sha256 AS s FROM case_original c WHERE c.case_id = ? AND NOT EXISTS (SELECT 1 FROM case_original o WHERE o.sha256 = c.sha256 AND o.case_id <> c.case_id)', caseId)).map((r) => r.s),
	};
	const before: Plan = prior ? (JSON.parse(prior) as Plan) : { versions: [], exports: [], originals: [] };
	const plan: Plan = { versions: union(before.versions, found.versions), exports: union(before.exports, found.exports), originals: union(before.originals, found.originals) };
	const building = await all<{ object_key: string; upload_id: string }>(ctx.db, "SELECT object_key, upload_id FROM export_job WHERE case_id = ? AND state = 'building'", caseId);
	const t = await catalog(ctx);
	const statements: [string, D1Value[]][] = [
		set,
		['UPDATE case_deletion SET erase_plan = ? WHERE case_id = ?', [JSON.stringify(plan), caseId]],
		...t.versionT.map((x): [string, D1Value[]] => [`DELETE FROM ${x} WHERE version_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(plan.versions)]]),
		...t.exportT.map((x): [string, D1Value[]] => [`DELETE FROM ${x} WHERE export_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(plan.exports)]]),
		...t.caseT.map((x): [string, D1Value[]] => [`DELETE FROM ${x} WHERE case_id = ?`, [caseId]]),
		...t.parents.map((x): [string, D1Value[]] => [`DELETE FROM ${x} WHERE case_id = ?`, [caseId]]),
		['DELETE FROM original WHERE sha256 IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM case_original c WHERE c.sha256 = original.sha256)', [JSON.stringify(plan.originals)]],
	];
	await guarded(ctx.db, condition[0], condition[1], statements);
	// R2 after D1: once the rows are gone nothing serves these objects, and a repeat of this call deletes what is left.
	const keys: string[] = [];
	for (const prefix of [...plan.versions.flatMap((v) => [`pkg/${v}/`, `rm/${v}/`]), `export/${caseId}/`, `backup/${caseId}/`, `bundle/${caseId}/`]) {
		for (let cursor: string | undefined; ; ) {
			const page = await ctx.bucket.list({ prefix, cursor });
			keys.push(...page.objects.map((o) => o.key));
			if (!page.truncated) break;
			cursor = page.cursor;
		}
	}
	// Restore packets staged from the case's recovery copies carry its id; GRS-109's own uploads name no case (see rotate).
	for (const o of await listed(ctx.bucket, 'import/')) if (o.customMetadata?.caseId === caseId) keys.push(o.key);
	for (const sha of plan.originals) if (!(await first(ctx.db, 'SELECT 1 AS x FROM case_original WHERE sha256 = ?', sha))) keys.push(`orig/${sha}`);
	for (let i = 0; i < keys.length; i += 1000) await ctx.bucket.delete(keys.slice(i, i + 1000));
	for (const b of building) await ctx.bucket.resumeMultipartUpload(b.object_key, b.upload_id).abort().catch(() => undefined); // an unsealed export's parts
	return { plan, objects: keys.length };
}

// ----- deletion records -----

const RECORD_FORMAT = 'clearcase.deletion-record/1';
type DeletionRecord = { format: string; client: string; caseId: string; requestedBy: string; requestedAt: string; approvedBy: string; approvedAt: string; offeredExport: { exportId: string; sha256: string; size: number; offeredAt: string }; removedBy: string; removedAt: string };
const RECORD_KEYS = 'approvedAt,approvedBy,caseId,client,format,offeredExport,removedAt,removedBy,requestedAt,requestedBy';
const recordKey = (caseId: string) => `deletion/${caseId}.json`;
const ACTOR = /^[a-z-]{1,40}:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
let ledgerSize: number | null = null; // per isolate: how many deletion records D1 was last seen to hold as removed

/** The record of a removed case, in one key order, so both buckets hold the same bytes. */
function recordOf(d: Deletion, client: string): DeletionRecord {
	if (d.state !== 'removed' || !d.approved_by || !d.approved_at || !d.export_id || !d.export_sha256 || d.export_size === null || !d.offered_at || !d.removed_by || !d.removed_at) refuse(503, 'invalid-deletion-state', { caseId: d.case_id });
	return { format: RECORD_FORMAT, client, caseId: d.case_id, requestedBy: d.requested_by, requestedAt: d.requested_at, approvedBy: d.approved_by!, approvedAt: d.approved_at!, offeredExport: { exportId: d.export_id!, sha256: d.export_sha256!, size: d.export_size!, offeredAt: d.offered_at! }, removedBy: d.removed_by!, removedAt: d.removed_at! };
}

/** A stored record, every field checked: one of another client, or one missing or retyping a field, is never applied and never skipped. */
function parseRecord(ctx: Ctx, key: string, text: string, binding: string): DeletionRecord {
	const bad = (): never => refuse(503, 'invalid-deletion-record', { binding });
	let r: unknown;
	try {
		r = JSON.parse(text);
	} catch {
		return bad();
	}
	if (!isObject(r) || Object.keys(r).sort().join() !== RECORD_KEYS || r.format !== RECORD_FORMAT) return bad();
	if (r.client !== ctx.client) refuse(503, 'foreign-deletion-record', { binding });
	if (!isText(ID)(r.caseId) || key !== recordKey(r.caseId)) return bad();
	for (const f of ['requestedBy', 'approvedBy', 'removedBy']) if (!isText(ACTOR)(r[f])) bad();
	for (const f of ['requestedAt', 'approvedAt', 'removedAt']) if (!isText(ISO)(r[f])) bad();
	const e = r.offeredExport;
	if (!isObject(e) || Object.keys(e).sort().join() !== 'exportId,offeredAt,sha256,size' || !isText(UUID)(e.exportId) || !isText(SHA)(e.sha256) || !isCount(e.size) || !isText(ISO)(e.offeredAt)) bad();
	return r as unknown as DeletionRecord;
}

/** Write-once in both buckets: the same bytes again are a no-op, other bytes under the key are refused. */
async function writeRecord(ctx: Ctx, record: DeletionRecord) {
	const text = JSON.stringify(record);
	const sha = await sha256Hex(text);
	for (const [bucket, binding] of [[ctx.bucket, 'BUCKET'], [ctx.copies, 'RECOVERY']] as const) {
		const held = await bucket.head(recordKey(record.caseId));
		if (held) {
			if (!held.checksums.sha256 || hex(held.checksums.sha256) !== sha) refuse(503, 'conflicting-deletion-record', { binding, caseId: record.caseId });
			continue;
		}
		await bucket.put(recordKey(record.caseId), text, { sha256: sha, customMetadata: { client: ctx.client } });
	}
}

/** Every deletion record in the live bucket and in RECOVERY, by case. The two must agree where both hold a record. */
async function readLedger(ctx: Ctx): Promise<Map<string, DeletionRecord>> {
	const out = new Map<string, { record: DeletionRecord; text: string; in: string[] }>();
	for (const [bucket, binding] of [[ctx.bucket, 'BUCKET'], [ctx.copies, 'RECOVERY']] as const) {
		for (const o of await listed(bucket, 'deletion/')) {
			const body = await bucket.get(o.key);
			if (!hasBody(body)) refuse(503, 'invalid-deletion-record', { binding });
			const text = await (body as R2ObjectBody).text();
			const record = parseRecord(ctx, o.key, text, binding);
			const seen = out.get(record.caseId);
			if (seen && seen.text !== text) refuse(503, 'conflicting-deletion-record', { binding, caseId: record.caseId });
			if (seen) seen.in.push(binding);
			else out.set(record.caseId, { record, text, in: [binding] });
		}
	}
	for (const r of out.values()) if (r.in.length < 2) await writeRecord(ctx, r.record); // one bucket lost it: copy it back
	return new Map([...out].map(([k, v]) => [k, v.record]));
}

/** Brings D1 in line with the ledger: every recorded case is removed and erased, and every removed case has its record. */
async function reconcile(ctx: Ctx) {
	const ledger = await readLedger(ctx);
	const removed = await all<Deletion>(ctx.db, "SELECT * FROM case_deletion WHERE state = 'removed'");
	for (const d of removed) if (!ledger.has(d.case_id)) (await writeRecord(ctx, recordOf(d, ctx.client)), ledger.set(d.case_id, recordOf(d, ctx.client)));
	const applied = new Set(removed.map((d) => d.case_id));
	for (const r of ledger.values()) {
		if (applied.has(r.caseId)) continue;
		const e = r.offeredExport;
		await erase(ctx, r.caseId, ["INSERT INTO case_deletion (case_id, state, requested_by, requested_at, approved_by, approved_at, export_id, export_sha256, export_size, offered_at, removed_by, removed_at) VALUES (?, 'removed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (case_id) DO UPDATE SET state = 'removed', requested_by = excluded.requested_by, requested_at = excluded.requested_at, approved_by = excluded.approved_by, approved_at = excluded.approved_at, export_id = excluded.export_id, export_sha256 = excluded.export_sha256, export_size = excluded.export_size, offered_at = excluded.offered_at, removed_by = excluded.removed_by, removed_at = excluded.removed_at", [r.caseId, r.requestedBy, r.requestedAt, r.approvedBy, r.approvedAt, e.exportId, e.sha256, e.size, e.offeredAt, r.removedBy, r.removedAt]], ['1 = 1', []]);
	}
	ledgerSize = ledger.size;
}

/** Whether a restore would bring back a removed case: D1 says so, or either bucket holds its record. */
async function isDeleted(ctx: Ctx, caseId: string): Promise<boolean> {
	if ((await deletionOf(ctx, caseId))?.state === 'removed') return true;
	return !!(await ctx.bucket.head(recordKey(caseId))) || !!(await ctx.copies.head(recordKey(caseId)));
}

async function deletionStep(ctx: Ctx, request: Request, caseId: string, step: Step): Promise<Response> {
	const b = await body(request);
	const who = actor(b, step);
	const now = new Date().toISOString();
	const d = await deletionOf(ctx, caseId);
	const expect = (state: Deletion['state'] | null) => {
		if ((d?.state ?? null) !== state) refuse(409, 'wrong-state', { step, state: d?.state ?? null });
	};
	try {
		if (step === 'request') {
			expect(null);
			if (!(await first(ctx.db, 'SELECT 1 AS x FROM active WHERE case_id = ?', caseId))) refuse(404, 'no-such-case');
			await guarded(ctx.db, 'NOT EXISTS (SELECT 1 FROM case_deletion WHERE case_id = ?)', [caseId], [["INSERT INTO case_deletion (case_id, state, requested_by, requested_at) VALUES (?, 'requested', ?, ?)", [caseId, who, now]]]);
		} else if (step === 'approve') {
			expect('requested');
			await guarded(ctx.db, "EXISTS (SELECT 1 FROM case_deletion WHERE case_id = ? AND state = 'requested')", [caseId], [["UPDATE case_deletion SET state = 'approved', approved_by = ?, approved_at = ? WHERE case_id = ?", [who, now, caseId]]]);
		} else if (step === 'offer') {
			expect('approved');
			const exportId = field(b, 'exportId', isText(UUID));
			const job = await first<{ state: string; sha256: string | null; size: number | null }>(ctx.db, 'SELECT state, sha256, size FROM export_job WHERE export_id = ? AND case_id = ?', exportId, caseId);
			if (!job) refuse(404, 'no-such-export');
			if (job!.state !== 'complete' || !job!.sha256) refuse(409, 'export-not-sealed');
			await guarded(ctx.db, "EXISTS (SELECT 1 FROM case_deletion WHERE case_id = ? AND state = 'approved')", [caseId], [["UPDATE case_deletion SET state = 'offered', export_id = ?, export_sha256 = ?, export_size = ?, offered_at = ? WHERE case_id = ?", [exportId, job!.sha256, job!.size, now, caseId]]]);
		} else {
			if (d?.state === 'removed') return json({ caseId, state: 'removed', repeated: true, ...(await erase(ctx, caseId, ['SELECT 1', []], ["EXISTS (SELECT 1 FROM case_deletion WHERE case_id = ? AND state = 'removed')", [caseId]])) });
			expect('offered');
			// The record is durable in both buckets before anything is erased: if the erasure stops part-way, the next
			// request finds a record D1 does not hold as removed, and reconcile finishes it.
			await writeRecord(ctx, recordOf({ ...d!, state: 'removed', removed_by: who, removed_at: now }, ctx.client));
			ledgerSize = null;
			const out = await erase(ctx, caseId, ["UPDATE case_deletion SET state = 'removed', removed_by = ?, removed_at = ? WHERE case_id = ?", [who, now, caseId]], ["EXISTS (SELECT 1 FROM case_deletion WHERE case_id = ? AND state = 'offered')", [caseId]]);
			return json({ caseId, state: 'removed', repeated: false, ...out });
		}
	} catch (e) {
		if (e instanceof GuardFailed) refuse(409, 'wrong-state', { step });
		throw e;
	}
	return json({ caseId, ...(await deletionOf(ctx, caseId)) });
}

// ----- recovery copies -----

const copyKey = (caseId: string, copyId: string) => `recovery/${caseId}/${copyId}.zip`;

/** Streams an object into another key, R2 refusing the write unless its bytes hash to `sha256`. */
async function copyVerified(from: R2, key: string, to: R2, target: string, sha256: string, size: number, customMetadata: Record<string, string>) {
	const o = await from.get(key);
	if (!hasBody(o) || (o as R2ObjectBody).size !== size) refuse(410, 'integrity', { key });
	const fls = fixedLength(size);
	const piped = (o as R2ObjectBody).body.pipeTo(fls.writable);
	try {
		await Promise.all([to.put(target, fls.readable, { sha256, customMetadata }), piped]);
	} catch (err) {
		if (/SHA-256/i.test(String(err))) refuse(422, 'copy-corrupted', { key });
		throw err;
	}
}

async function makeCopy(ctx: Ctx, request: Request): Promise<Response> {
	const b = await body(request);
	const caseId = field(b, 'caseId', isText(ID));
	const exportId = field(b, 'exportId', isText(UUID));
	const job = await first<{ state: string; sha256: string | null; size: number | null; object_key: string }>(ctx.db, 'SELECT state, sha256, size, object_key FROM export_job WHERE export_id = ? AND case_id = ?', exportId, caseId);
	if (!job) refuse(404, 'no-such-export');
	if (job!.state !== 'complete' || !job!.sha256 || job!.size === null) refuse(409, 'export-not-sealed');
	const copyId = crypto.randomUUID();
	const key = copyKey(caseId, copyId);
	await copyVerified(ctx.bucket, job!.object_key, ctx.copies, key, job!.sha256!, job!.size!, { client: ctx.client, caseId, exportId, sha256: job!.sha256! });
	const head = (await ctx.copies.head(key)) as Stored | null;
	if (!head) refuse(500, 'copy-missing');
	return json({ copyId, key, sha256: job!.sha256, size: job!.size, uploaded: head!.uploaded.toISOString() });
}

async function listed(bucket: R2, prefix: string): Promise<Stored[]> {
	const out: Stored[] = [];
	for (let cursor: string | undefined; ; ) {
		const page = await bucket.list({ prefix, cursor, include: ['customMetadata'] });
		out.push(...(page.objects as Stored[]));
		if (!page.truncated) break;
		cursor = page.cursor;
	}
	return out;
}

/** A copy back into the live bucket as a restore packet, for GRS-109's open, step and finish. */
async function stageCopy(ctx: Ctx, request: Request, copyId: string): Promise<Response> {
	const caseId = field(await body(request), 'caseId', isText(ID));
	if (await isDeleted(ctx, caseId)) refuse(409, 'case-deleted', { caseId });
	const key = copyKey(caseId, copyId);
	const head = await ctx.copies.head(key);
	if (!head) refuse(404, 'no-such-copy');
	const meta = head!.customMetadata ?? {};
	if (meta.client !== ctx.client) refuse(409, 'wrong-client');
	if (meta.caseId !== caseId || !isText(SHA)(meta.sha256)) refuse(422, 'invalid-copy', { key });
	const packetId = crypto.randomUUID();
	// Tagged with its case, so the case's removal can find the packet (erase) and a finished restore can drop it (route).
	await copyVerified(ctx.copies, key, ctx.bucket, `import/${packetId}.zip`, meta.sha256!, head!.size, { client: ctx.client, caseId });
	return json({ packetId, copyId, caseId, sha256: meta.sha256, size: head!.size });
}

/** Removes recovery copies, and restore packets, older than 30 days at `scheduledTime` (a Cron Trigger's scheduled time); nothing else. */
async function rotate(ctx: Ctx, request: Request): Promise<Response> {
	const at = field(await body(request), 'scheduledTime', isText(ISO));
	const now = Date.parse(at);
	if (!Number.isFinite(now)) refuse(400, 'invalid-field', { field: 'scheduledTime' });
	const copies = await listed(ctx.copies, 'recovery/');
	const old = copies.filter((o) => now - o.uploaded.getTime() > RETENTION_MS).map((o) => o.key);
	for (let i = 0; i < old.length; i += 1000) await ctx.copies.delete(old.slice(i, i + 1000));
	// A restore packet is transient. One that GRS-109's upload route made names no case until it is opened, so removal cannot
	// find it; it ages out here with the copies.
	const packets = (await listed(ctx.bucket, 'import/')).filter((o) => now - o.uploaded.getTime() > RETENTION_MS).map((o) => o.key);
	for (let i = 0; i < packets.length; i += 1000) await ctx.bucket.delete(packets.slice(i, i + 1000));
	return json({ scheduledTime: at, removed: old, kept: copies.length - old.length, packetsRemoved: packets.length });
}

// ----- bundle history (a GRS-128 stand-in) -----

async function putBundle(ctx: Ctx, request: Request, caseId: string, bundleId: string): Promise<Response> {
	const sha = isText(SHA)(request.headers.get('x-sha256')) ? request.headers.get('x-sha256')! : refuse(400, 'invalid-field', { field: 'x-sha256' });
	const size = Number(request.headers.get('content-length'));
	if (!isCount(size) || !request.body) refuse(411, 'length-required');
	const key = `bundle/${caseId}/${bundleId}.pdf`;
	if (await ctx.bucket.head(key)) refuse(409, 'bundle-version-exists'); // a bundle version is never overwritten
	try {
		await ctx.bucket.put(key, request.body!, { sha256: sha, customMetadata: { client: ctx.client } });
	} catch (e) {
		if (/SHA-256/i.test(String(e))) refuse(422, 'digest-mismatch');
		throw e;
	}
	await ctx.db.batch([ctx.db.prepare('INSERT INTO bundle_version (case_id, bundle_id, sha256, size, created_at) VALUES (?, ?, ?, ?, ?)').bind(caseId, bundleId, sha, size, new Date().toISOString())]);
	return json({ key, sha256: sha, size });
}

// ----- routing -----

const INTROSPECT = /^(orig|pkg|rm|backup|export|bundle|recovery|deletion|import)\//;

async function route(request: Request, env: RecoveryEnv): Promise<Response> {
	const opened = await open(env);
	if (opened instanceof Response) return opened;
	const ctx = opened;
	const url = new URL(request.url);
	const seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
	const m = request.method;
	if (seg[0] === 'recovery') {
		if (m === 'POST' && seg.length === 2 && seg[1] === 'copies') return makeCopy(ctx, request);
		if (m === 'GET' && seg.length === 2 && seg[1] === 'copies') return json((await listed(ctx.copies, 'recovery/')).map((o) => ({ key: o.key, caseId: o.customMetadata?.caseId ?? null, sha256: o.customMetadata?.sha256 ?? null, size: o.size, uploaded: o.uploaded.toISOString() })));
		if (m === 'POST' && seg.length === 4 && seg[1] === 'copies' && isText(UUID)(seg[2]) && seg[3] === 'stage') return stageCopy(ctx, request, seg[2]);
		if (m === 'POST' && seg.length === 2 && seg[1] === 'rotate') return rotate(ctx, request);
		if (m === 'GET' && seg.length === 2 && seg[1] === 'ledger') return json([...(await readLedger(ctx)).values()].sort((a, b) => a.caseId.localeCompare(b.caseId)));
		// Read-only introspection for the runner: what a key holds in the live bucket or in RECOVERY.
		if (m === 'GET' && seg[1] === 'head' && (seg[2] === 'live' || seg[2] === 'copies') && seg.length > 3) {
			const key = seg.slice(3).join('/');
			const o = INTROSPECT.test(key) ? await (seg[2] === 'live' ? ctx.bucket : ctx.copies).head(key) : null;
			return o ? json({ key, size: o.size }) : json({ code: 'not-found' }, 404);
		}
		return json({ code: 'not-found' }, 404);
	}
	if (m === 'POST' && seg[0] === 'restore' && seg[1] === 'packets' && seg.length === 4 && ['open', 'step', 'finish'].includes(seg[3]!)) {
		// GRS-109's restore names its case in the body; a removed case is refused before the storage Worker reads the packet.
		const caseId = await request.clone().json().then((b: unknown) => (isObject(b) ? b.caseId : null), () => null);
		if (isText(ID)(caseId) && (await isDeleted(ctx, caseId))) {
			if (isText(UUID)(seg[2])) await ctx.bucket.delete(`import/${seg[2]}.zip`); // the packet holds the deleted case's data
			return json({ code: 'case-deleted', caseId }, 409);
		}
		if (seg[3] === 'finish' && isText(UUID)(seg[2])) {
			// A finished restore leaves the case's objects under their own keys; the packet, a second copy of the backup, goes.
			const finished = await storage.fetch(request, env);
			if (finished.status === 200) await ctx.bucket.delete(`import/${seg[2]}.zip`);
			return finished;
		}
	}
	if (seg[0] === 'cases' && isText(ID)(seg[1])) {
		const caseId = seg[1];
		const rest = seg.slice(2);
		if (rest[0] === 'deletion') {
			if (m === 'GET' && rest.length === 1) {
				const d = await deletionOf(ctx, caseId);
				return d ? json(d) : json({ code: 'not-found' }, 404);
			}
			if (m === 'POST' && rest.length === 2 && Object.hasOwn(ROLE, rest[1]!)) return deletionStep(ctx, request, caseId, rest[1] as Step);
			return json({ code: 'not-found' }, 404);
		}
		if ((await deletionOf(ctx, caseId))?.state === 'removed') return json({ code: 'case-deleted', caseId }, 410);
		if (m === 'PUT' && rest[0] === 'bundles' && rest.length === 2 && isText(ID)(rest[1])) return putBundle(ctx, request, caseId, rest[1]);
		if (m === 'GET' && rest.join('/') === 'bundles') return json(await all(ctx.db, 'SELECT bundle_id, sha256, size, created_at FROM bundle_version WHERE case_id = ? ORDER BY bundle_id', caseId));
	}
	return storage.fetch(request, env);
}

export default {
	async fetch(request: Request, env: RecoveryEnv): Promise<Response> {
		try {
			return await route(request, env);
		} catch (e) {
			if (e instanceof Refused) return json({ code: e.code, ...e.detail }, e.status);
			return json({ code: 'internal', message: String(e instanceof Error ? e.message : e) }, 500);
		} finally {
			if (request.body && !request.bodyUsed) await request.body.pipeTo(new WritableStream()).catch(() => undefined);
		}
	},
};
