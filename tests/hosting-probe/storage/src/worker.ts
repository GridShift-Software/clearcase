// The storage probe's Worker (GRS-109): the per-client D1 and R2 layout of schema.sql, served by native workerd under
// `wrangler dev --local`. It is a probe of the storage design, not the product: no identity or session, one deployment per
// client, and every route answers JSON or the verified bytes. Each response names the D1 statements, batches and R2
// operations it took (x-probe-* headers), which the runner counts to choose the layout.
//
// Integrity rules it proves:
// - every request first checks that its D1 database and R2 bucket both belong to the deployment's client (crossed or
//   missing identity: 503, nothing read or written);
// - the whole object a byte belongs to is hashed and matched against its recorded SHA-256 and size (410 and no bytes
//   otherwise), ranges included. Up to 32 MiB that happens before the first byte leaves. Beyond it the object is read
//   twice: the first read hashes it before the headers, the second hashes again while streaming and holds back its last
//   chunk until the digest matches, so a change between the reads ends the response in an error before its last byte;
//   the bytes before that chunk have already left;
// - every multi-statement write is one D1 batch whose first statement is a guard; a failed guard rolls the batch back.
import { type D1, type D1Result, type D1Value, type Env, type R2, type R2Object, type R2ObjectBody, type R2UploadedPart, digestStream, fixedLength, hasBody, hex, sha256Hex } from './platform.ts';
import { type Sha256State, Sha256 } from './sha256.ts';
import { DESCRIPTOR_SIZE, type Entry, centralDirectory, checkLocal, crc32, descriptor, locate, localHeader, localHeaderSize, trailer } from './zip.ts';

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

const MiB = 1024 * 1024;
const SINGLE_PUT_MAX = 64 * MiB; // larger uploads go through multipart parts, each under the Workers request-body limit
const BUFFER_MAX = 32 * MiB; // a verified original up to this size, or a range up to it, is served from one hashing pass; larger ones from two
const PART = 8 * MiB; // an export step writes one multipart part of exactly this size; only the packet's last part is shorter
const RESTORE_STEP_BYTES = 64 * MiB;
const BACKUP_FORMAT = 'clearcase.case-packet/1';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[0-9a-f]{64}$/;
const VERSION = /^sha256:[0-9a-f]{64}$/;
const PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

type Counts = { statements: number; batches: number; r2: number; rowsRead: number; rowsWritten: number };
type Row = Record<string, unknown>;

/** D1 through one door, so every statement and batch is counted and a failed guard is recognised. */
function sql(db: D1, c: Counts) {
	const tally = (r: D1Result<unknown>) => ((c.rowsRead += r.meta.rows_read ?? 0), (c.rowsWritten += r.meta.rows_written ?? 0));
	return {
		async all<T = Row>(text: string, ...params: D1Value[]): Promise<T[]> {
			c.statements++;
			const r = await db.prepare(text).bind(...params).all<T>();
			tally(r);
			return r.results;
		},
		async first<T = Row>(text: string, ...params: D1Value[]): Promise<T | null> {
			return (await this.all<T>(text, ...params))[0] ?? null;
		},
		async batch(statements: [string, D1Value[]][]): Promise<D1Result<Row>[]> {
			c.statements += statements.length;
			c.batches++;
			try {
				const out = await db.batch(statements.map(([t, p]) => db.prepare(t).bind(...p)));
				for (const r of out) tally(r);
				return out;
			} catch (e) {
				if (String(e).includes('batch_guard.token')) throw new GuardFailed();
				throw e;
			}
		},
	};
}
type Sql = ReturnType<typeof sql>;

/** The guard that opens a guarded batch, and the statement that closes it. */
const guard = (condition: string, ...params: D1Value[]): [string, D1Value[]] => [`INSERT INTO batch_guard (token) SELECT CASE WHEN ${condition} THEN 'ok' END`, params];
const CLEAR: [string, D1Value[]] = ['DELETE FROM batch_guard', []];
const FAIL: [string, D1Value[]] = ['INSERT INTO batch_guard (token) VALUES (NULL)', []];

function counted(bucket: R2, c: Counts): R2 {
	return new Proxy(bucket, {
		get(target, prop) {
			const v = (target as unknown as Record<PropertyKey, unknown>)[prop];
			return typeof v === 'function' ? (...args: unknown[]) => (c.r2++, (v as (...a: unknown[]) => unknown).apply(target, args)) : v;
		},
	});
}

type Ctx = { client: string; db: Sql; bucket: R2; counts: Counts };
let verifiedClient: string | null = null; // per isolate: bindings cannot change under a running isolate

const isBinding = (v: unknown, ...methods: string[]) => typeof v === 'object' && v !== null && methods.every((m) => typeof (v as Row)[m] === 'function');

async function open(env: Env): Promise<Ctx> {
	const client = typeof env.CLEARCASE_CLIENT_ID === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(env.CLEARCASE_CLIENT_ID) ? env.CLEARCASE_CLIENT_ID : refuse(503, 'missing-binding', { binding: 'CLEARCASE_CLIENT_ID' });
	if (!isBinding(env.DB, 'prepare', 'batch')) refuse(503, 'missing-binding', { binding: 'DB' });
	if (!isBinding(env.BUCKET, 'get', 'put', 'head')) refuse(503, 'missing-binding', { binding: 'BUCKET' });
	const counts: Counts = { statements: 0, batches: 0, r2: 0, rowsRead: 0, rowsWritten: 0 };
	const ctx: Ctx = { client, db: sql(env.DB as D1, counts), bucket: counted(env.BUCKET as R2, counts), counts };
	if (verifiedClient !== client) {
		// The other client's identifier is never echoed: a crossed deployment learns only that its binding is wrong.
		const row = await ctx.db.first<{ client_id: unknown }>('SELECT client_id FROM storage_identity WHERE singleton = 1').catch(() => null);
		if (!row || typeof row.client_id !== 'string' || !row.client_id) refuse(503, 'missing-identity', { binding: 'DB' });
		if (row!.client_id !== client) refuse(503, 'crossed-binding', { binding: 'DB' });
		const object = await ctx.bucket.get('identity/client.json');
		let r2Client: unknown = null;
		if (hasBody(object)) r2Client = await object.text().then((t) => (JSON.parse(t) as Row).client_id, () => null);
		if (typeof r2Client !== 'string' || !r2Client) refuse(503, 'missing-identity', { binding: 'BUCKET' });
		if (r2Client !== client) refuse(503, 'crossed-binding', { binding: 'BUCKET' });
		verifiedClient = client;
	}
	return ctx;
}

const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
function json(ctx: Ctx | null, body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, 'content-type': 'application/json', ...probeHeaders(ctx) } });
}
const probeHeaders = (ctx: Ctx | null): Record<string, string> =>
	ctx ? { 'x-probe-d1-statements': String(ctx.counts.statements), 'x-probe-d1-batches': String(ctx.counts.batches), 'x-probe-r2-ops': String(ctx.counts.r2), 'x-probe-d1-rows-written': String(ctx.counts.rowsWritten), 'x-probe-d1-rows-read': String(ctx.counts.rowsRead) } : {};

async function body(request: Request): Promise<Row> {
	const value = await request.json().catch(() => refuse(400, 'invalid-json'));
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : refuse(400, 'invalid-json');
}
/** A field that must be present with its exact shape; missing, null or retyped is a refusal, never a default. */
function field<T>(o: Row, name: string, ok: (v: unknown) => v is T): T {
	return ok(o[name]) ? (o[name] as T) : refuse(400, 'invalid-field', { field: name });
}
const isText = (re: RegExp) => (v: unknown): v is string => typeof v === 'string' && re.test(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isObject = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const isRows = (v: unknown): v is Row[] => Array.isArray(v) && v.every(isObject);

const checksum = (o: R2Object) => (o.checksums.sha256 ? hex(o.checksums.sha256) : null);

/** Hashes a stored object whole, keeping only bytes [start, end] (inclusive), and refuses it unless it matches. */
async function readVerified(ctx: Ctx, key: string, sha256: string, size: number, keep: { start: number; end: number } | null): Promise<Uint8Array<ArrayBuffer>> {
	const object = await ctx.bucket.get(key);
	if (!hasBody(object)) refuse(410, 'missing-original', { key });
	if ((object as R2ObjectBody).size !== size) refuse(410, 'changed-original', { key, check: 'size' });
	const [start, end] = keep ? [keep.start, keep.end] : [0, size - 1];
	const out = new Uint8Array(Math.max(0, end - start + 1));
	const ds = digestStream();
	const w = ds.getWriter();
	let at = 0;
	for await (const chunk of (object as R2ObjectBody).body) {
		await w.write(chunk);
		const from = Math.max(start, at);
		const to = Math.min(end + 1, at + chunk.length);
		if (from < to) out.set(chunk.subarray(from - at, to - at), from - start);
		at += chunk.length;
	}
	await w.close();
	if (at !== size || hex(await ds.digest) !== sha256) refuse(410, 'changed-original', { key, check: 'sha256' });
	return out;
}

/** Hashes a stored object whole without keeping it; returns its etag. */
async function hashWhole(ctx: Ctx, key: string, sha256: string, size: number): Promise<string> {
	const object = await ctx.bucket.get(key);
	if (!hasBody(object)) refuse(410, 'missing-original', { key });
	const o = object as R2ObjectBody;
	if (o.size !== size) refuse(410, 'changed-original', { key, check: 'size' });
	const ds = digestStream();
	await o.body.pipeTo(ds);
	if (hex(await ds.digest) !== sha256) refuse(410, 'changed-original', { key, check: 'sha256' });
	return o.etag;
}

/**
 * Streams bytes [start, end] (inclusive) of an object whose first read already matched, hashing this second read whole as
 * it goes. The last chunk of the range is held back until the second read has ended and its digest and length are the
 * recorded ones; if they are not, the stream errors, so the response ends before its last byte. Earlier chunks have left.
 */
function verifiedStream(body: ReadableStream<Uint8Array>, sha256: string, size: number, start: number, end: number): ReadableStream<Uint8Array> {
	const ds = digestStream();
	const w = ds.getWriter();
	let at = 0;
	let held: Uint8Array | null = null;
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			async transform(chunk, c) {
				await w.write(chunk);
				const from = Math.max(start, at);
				const to = Math.min(end + 1, at + chunk.length);
				const first = at;
				at += chunk.length;
				if (from >= to) return;
				if (held) c.enqueue(held);
				held = chunk.subarray(from - first, to - first);
			},
			async flush(c) {
				await w.close();
				if (at !== size || held === null || hex(await ds.digest) !== sha256) return c.error(new Error('changed-original'));
				c.enqueue(held);
			},
		}),
	);
}

/** One `bytes=a-b`, `bytes=a-` or `bytes=-n` range; anything else (several ranges included) is unsatisfiable. */
function parseRange(header: string | null, size: number): { start: number; end: number } | null | 'unsatisfiable' {
	if (header === null) return null;
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!m || (m[1] === '' && m[2] === '')) return 'unsatisfiable';
	if (m[1] === '') {
		const n = Number(m[2]);
		return n > 0 && size > 0 ? { start: Math.max(0, size - n), end: size - 1 } : 'unsatisfiable';
	}
	const start = Number(m[1]);
	const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
	return start <= end && start < size ? { start, end } : 'unsatisfiable';
}

async function serveOriginal(ctx: Ctx, request: Request, caseId: string, assetId: string): Promise<Response> {
	const row = await ctx.db.first<{ sha256: string; size: number; filename: string; media_type: string }>('SELECT o.sha256, o.size, c.filename, c.media_type FROM case_original c JOIN original o ON o.sha256 = c.sha256 WHERE c.case_id = ? AND c.asset_id = ?', caseId, assetId);
	if (!row) return json(ctx, { code: 'not-found' }, 404);
	const key = `orig/${row.sha256}`;
	const range = parseRange(request.headers.get('range'), row.size);
	if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...NO_STORE, 'content-range': `bytes */${row.size}`, ...probeHeaders(ctx) } });
	const headers: Record<string, string> = { ...NO_STORE, 'content-type': row.media_type, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`, 'accept-ranges': 'bytes', etag: `"${row.sha256}"` };
	const head = request.method === 'HEAD';
	if (range && range.end - range.start + 1 <= BUFFER_MAX) {
		const bytes = await readVerified(ctx, key, row.sha256, row.size, range);
		return new Response(head ? null : bytes, { status: 206, headers: { ...headers, 'content-range': `bytes ${range.start}-${range.end}/${row.size}`, 'content-length': String(bytes.length), ...probeHeaders(ctx) } });
	}
	if (!range && row.size <= BUFFER_MAX) {
		const bytes = await readVerified(ctx, key, row.sha256, row.size, null);
		return new Response(head ? null : bytes, { status: 200, headers: { ...headers, 'content-length': String(bytes.length), ...probeHeaders(ctx) } });
	}
	// Too large to hold: hash the whole object first, then stream a second read pinned to the verified etag, hashed again
	// whole (a range included); its last chunk is held until that digest matches (verifiedStream).
	const etag = await hashWhole(ctx, key, row.sha256, row.size);
	const [start, end] = range ? [range.start, range.end] : [0, row.size - 1];
	const again = await ctx.bucket.get(key, { onlyIf: { etagMatches: etag } });
	if (!hasBody(again)) refuse(410, 'changed-original', { key, check: 'etag' });
	const meta = { ...headers, 'content-length': String(end - start + 1), ...probeHeaders(ctx), ...(range ? { 'content-range': `bytes ${start}-${end}/${row.size}` } : {}) };
	if (head) return new Response(null, { status: range ? 206 : 200, headers: meta });
	return new Response(verifiedStream((again as R2ObjectBody).body, row.sha256, row.size, start, end), { status: range ? 206 : 200, headers: meta });
}

// ----- uploads and finalize -----

async function putOriginal(ctx: Ctx, request: Request, sha: string): Promise<Response> {
	const length = Number(request.headers.get('content-length'));
	if (!Number.isSafeInteger(length) || length < 0 || !request.body) refuse(411, 'length-required');
	if (length > SINGLE_PUT_MAX) refuse(413, 'use-multipart', { max: SINGLE_PUT_MAX });
	const key = `orig/${sha}`;
	const existing = await ctx.bucket.head(key);
	if (existing) return checksum(existing) === sha && existing.size === length ? json(ctx, { stored: true, repeated: true }) : refuse(409, 'conflicting-object');
	try {
		await ctx.bucket.put(key, request.body!, { sha256: sha, customMetadata: { client: ctx.client } });
	} catch (e) {
		if (/SHA-256/i.test(String(e))) refuse(422, 'digest-mismatch');
		throw e;
	}
	return json(ctx, { stored: true, repeated: false });
}

async function finalize(ctx: Ctx, request: Request, caseId: string): Promise<Response> {
	const b = await body(request);
	const assetId = field(b, 'assetId', isText(ID));
	const sha = field(b, 'sha256', isText(SHA));
	const size = field(b, 'size', isCount);
	const filename = field(b, 'filename', isText(/^[^/\\\0]{1,200}$/));
	const mediaType = field(b, 'mediaType', isText(/^[a-z]+\/[a-z0-9.+-]+$/));
	const key = `orig/${sha}`;
	const object = await ctx.bucket.head(key);
	if (!object) refuse(409, 'not-uploaded');
	// The upload checked a SHA-256 only for single PUTs; multipart has none. Every original is hashed here before its
	// row exists, so a recorded original is always one whose stored bytes matched. A mismatch records nothing and deletes
	// nothing: the key may hold another case's verified bytes, and `size` is the caller's claim.
	try {
		await hashWhole(ctx, key, sha, size);
	} catch (e) {
		if (e instanceof Refused && e.code === 'changed-original') refuse(409, 'digest-mismatch', { check: e.detail.check });
		throw e;
	}
	try {
		await ctx.db.batch([
			guard('NOT EXISTS (SELECT 1 FROM case_original WHERE case_id = ? AND asset_id = ? AND sha256 <> ?)', caseId, assetId, sha),
			['INSERT INTO original (sha256, size) VALUES (?, ?) ON CONFLICT (sha256) DO NOTHING', [sha, size]],
			['INSERT INTO case_original (case_id, asset_id, sha256, filename, media_type) VALUES (?, ?, ?, ?, ?) ON CONFLICT (case_id, asset_id) DO NOTHING', [caseId, assetId, sha, filename, mediaType]],
			CLEAR,
		]);
	} catch (e) {
		if (e instanceof GuardFailed) refuse(409, 'asset-bound-to-another-original');
		throw e;
	}
	return json(ctx, { finalized: true, verifiedBytes: size });
}

// ----- import (P5) -----

const TABLES = {
	document: ['ref', 'row_json'],
	asset: ['asset_id', 'sha256', 'size', 'kind'],
	seed: ['seed_id', 'row_json'],
} as const;
type Table = keyof typeof TABLES;

const staging = (v: string, caseId: string) => guard("EXISTS (SELECT 1 FROM results_version WHERE version_id = ? AND case_id = ? AND state = 'staging')", v, caseId);

/** INSERT statements for `rows`: as JSON through json_each (one bound value per ~900 KB) or as bound rows (100 values per statement). */
function inserts(table: string, columns: readonly string[], rows: Row[], strategy: 'json' | 'bound', lead: { column: string; value: string } | null): [string, D1Value[]][] {
	const cols = lead ? [lead.column, ...columns] : [...columns];
	const out: [string, D1Value[]][] = [];
	if (strategy === 'json') {
		let chunk: Row[] = [];
		let bytes = 0;
		const flush = () => {
			if (!chunk.length) return;
			const select = columns.map((c) => `json_extract(value, '$.${c}')`).join(', ');
			out.push([`INSERT INTO ${table} (${cols.join(', ')}) SELECT ${lead ? '?, ' : ''}${select} FROM json_each(?)`, lead ? [lead.value, JSON.stringify(chunk)] : [JSON.stringify(chunk)]]);
			chunk = [];
			bytes = 0;
		};
		for (const r of rows) {
			const n = JSON.stringify(r).length;
			if (bytes + n > 900_000) flush();
			chunk.push(r);
			bytes += n;
		}
		flush();
	} else {
		const per = Math.floor(100 / cols.length);
		for (let i = 0; i < rows.length; i += per) {
			const slice = rows.slice(i, i + per);
			out.push([`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${slice.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')}`, slice.flatMap((r) => [...(lead ? [lead.value] : []), ...columns.map((c) => (r[c] ?? null) as D1Value)])]);
		}
	}
	return out;
}

async function begin(ctx: Ctx, request: Request, caseId: string, v: string): Promise<Response> {
	const b = await body(request);
	const expected = field(b, 'expected', isObject);
	const list = field(b, 'list', isObject);
	const e = { documents: field(expected, 'documents', isCount), assets: field(expected, 'assets', isCount), seeds: field(expected, 'seeds', isCount), files: field(expected, 'files', isCount) };
	const l = { sha256: field(list, 'sha256', isText(SHA)), size: field(list, 'size', isCount) };
	const row = await ctx.db.first<{ state: string; attempt: number; case_id: string }>('SELECT state, attempt, case_id FROM results_version WHERE version_id = ?', v);
	if (row && row.case_id !== caseId) refuse(409, 'version-of-another-case');
	if (row?.state === 'stored') refuse(409, 'stored');
	if (row) {
		// An interrupted attempt: its staged rows go, in one batch, before anything is written again.
		const out = await ctx.db.batch([
			guard("EXISTS (SELECT 1 FROM results_version WHERE version_id = ? AND state = 'staging' AND attempt = ?)", v, row.attempt),
			['DELETE FROM document WHERE version_id = ?', [v]],
			['DELETE FROM asset WHERE version_id = ?', [v]],
			['DELETE FROM seed WHERE version_id = ?', [v]],
			['DELETE FROM package_file WHERE version_id = ?', [v]],
			['UPDATE results_version SET attempt = attempt + 1, expected_documents = ?, expected_assets = ?, expected_seeds = ?, expected_files = ?, list_sha256 = ?, list_size = ? WHERE version_id = ?', [e.documents, e.assets, e.seeds, e.files, l.sha256, l.size, v]],
			CLEAR,
		]);
		return json(ctx, { attempt: row.attempt + 1, recovered: { documents: out[1]!.meta.changes, assets: out[2]!.meta.changes, seeds: out[3]!.meta.changes, files: out[4]!.meta.changes } });
	}
	await ctx.db.batch([["INSERT INTO results_version (version_id, case_id, state, attempt, expected_documents, expected_assets, expected_seeds, expected_files, list_sha256, list_size) VALUES (?, ?, 'staging', 1, ?, ?, ?, ?, ?, ?)", [v, caseId, e.documents, e.assets, e.seeds, e.files, l.sha256, l.size]]]);
	return json(ctx, { attempt: 1, recovered: null });
}

async function putPackageObject(ctx: Ctx, request: Request, caseId: string, v: string, key: string, sha: string, record: [string, D1Value[]] | null): Promise<Response> {
	const length = Number(request.headers.get('content-length'));
	if (!Number.isSafeInteger(length) || !request.body) refuse(411, 'length-required');
	if (length > SINGLE_PUT_MAX) refuse(413, 'use-multipart');
	const state = await ctx.db.first<{ state: string }>('SELECT state FROM results_version WHERE version_id = ? AND case_id = ?', v, caseId);
	if (state?.state !== 'staging') refuse(409, 'not-staging');
	const existing = await ctx.bucket.head(key);
	if (existing && checksum(existing) !== sha) refuse(409, 'conflicting-object');
	if (!existing) {
		try {
			await ctx.bucket.put(key, request.body!, { sha256: sha, customMetadata: { client: ctx.client } });
		} catch (e) {
			if (/SHA-256/i.test(String(e))) refuse(422, 'digest-mismatch');
			throw e;
		}
	}
	try {
		await ctx.db.batch([staging(v, caseId), ...(record ? [record] : []), CLEAR]);
	} catch (e) {
		if (e instanceof GuardFailed) refuse(409, 'not-staging');
		throw e;
	}
	return json(ctx, { stored: true, repeated: !!existing });
}

async function rows(ctx: Ctx, request: Request, caseId: string, v: string): Promise<Response> {
	const b = await body(request);
	const table = field(b, 'table', (x): x is Table => typeof x === 'string' && x in TABLES);
	const strategy = field(b, 'strategy', (x): x is 'json' | 'bound' => x === 'json' || x === 'bound');
	const items = field(b, 'rows', isRows);
	const fail = b.fail === true;
	for (const r of items) for (const c of TABLES[table]) if (!(c in r)) refuse(400, 'invalid-field', { field: c });
	const statements = inserts(table, TABLES[table], items, strategy, { column: 'version_id', value: v });
	try {
		await ctx.db.batch([staging(v, caseId), ...statements, ...(fail ? [FAIL] : []), CLEAR]);
	} catch (e) {
		if (e instanceof GuardFailed) return json(ctx, { code: fail ? 'injected-failure' : 'not-staging', statements: statements.length }, 409);
		throw e;
	}
	return json(ctx, { inserted: items.length, statements: statements.length });
}

/** The staged version's list and package files must be in R2 with the recorded size and SHA-256. */
async function verifyObjects(ctx: Ctx, v: string, list: { sha256: string; size: number }, files: { path: string; sha256: string; size: number }[]) {
	for (const [key, sha, size] of [[`rm/${v}/chronology.json`, list.sha256, list.size] as const, ...files.map((f) => [`pkg/${v}/${f.path}`, f.sha256, f.size] as const)]) {
		const o = await ctx.bucket.head(key);
		if (!o || o.size !== size || checksum(o) !== sha) refuse(409, 'incomplete', { missing: key });
	}
}

const count = (t: string) => `(SELECT count(*) FROM ${t} WHERE version_id = v.version_id)`;
/** Holds only while the version is staging with every row it expects. */
const hasEveryRow = (v: string, caseId: string) => guard(`EXISTS (SELECT 1 FROM results_version v WHERE v.version_id = ? AND v.case_id = ? AND v.state = 'staging' AND ${count('document')} = v.expected_documents AND ${count('asset')} = v.expected_assets AND ${count('seed')} = v.expected_seeds AND ${count('package_file')} = v.expected_files)`, v, caseId);
const incomplete = async (ctx: Ctx, v: string) => json(ctx, { code: 'incomplete', have: await ctx.db.first(`SELECT state, ${count('document')} AS documents, ${count('asset')} AS assets, ${count('seed')} AS seeds, ${count('package_file')} AS files FROM results_version v WHERE v.version_id = ?`, v) }, 409);

async function finish(ctx: Ctx, caseId: string, v: string): Promise<Response> {
	const files = await ctx.db.all<{ path: string; sha256: string; size: number }>('SELECT path, sha256, size FROM package_file WHERE version_id = ?', v);
	const version = await ctx.db.first<{ list_sha256: string; list_size: number }>('SELECT list_sha256, list_size FROM results_version WHERE version_id = ? AND case_id = ?', v, caseId);
	if (!version) refuse(404, 'not-found');
	await verifyObjects(ctx, v, { sha256: version!.list_sha256, size: version!.list_size }, files);
	try {
		await ctx.db.batch([hasEveryRow(v, caseId), ["UPDATE results_version SET state = 'stored' WHERE version_id = ?", [v]], CLEAR]);
	} catch (e) {
		if (!(e instanceof GuardFailed)) throw e;
		return incomplete(ctx, v);
	}
	return json(ctx, { stored: true });
}

async function activate(ctx: Ctx, request: Request, caseId: string): Promise<Response> {
	const b = await body(request);
	const v = field(b, 'version', isText(VERSION));
	const expected = b.expected === null ? null : field(b, 'expected', isText(VERSION));
	try {
		await ctx.db.batch([
			guard("EXISTS (SELECT 1 FROM results_version WHERE version_id = ? AND case_id = ? AND state = 'stored') AND coalesce((SELECT version_id FROM active WHERE case_id = ?), '') = ?", v, caseId, caseId, expected ?? ''),
			['INSERT INTO activation_log (case_id, seq, version_id, previous) SELECT ?, coalesce(max(seq), 0) + 1, ?, ? FROM activation_log WHERE case_id = ?', [caseId, v, expected, caseId]],
			['INSERT INTO active (case_id, version_id) VALUES (?, ?) ON CONFLICT (case_id) DO UPDATE SET version_id = excluded.version_id', [caseId, v]],
			CLEAR,
		]);
	} catch (e) {
		if (e instanceof GuardFailed) refuse(409, 'stale-or-unstored');
		throw e;
	}
	return json(ctx, { active: v });
}

// ----- reads -----

async function activeVersion(ctx: Ctx, caseId: string) {
	return ctx.db.first<{ version_id: string; list_sha256: string; list_size: number }>('SELECT v.version_id, v.list_sha256, v.list_size FROM active a JOIN results_version v ON v.version_id = a.version_id WHERE a.case_id = ?', caseId);
}

async function verifiedObject(ctx: Ctx, key: string, sha: string, size: number): Promise<Uint8Array<ArrayBuffer>> {
	const o = await ctx.bucket.get(key);
	if (!hasBody(o)) refuse(410, 'integrity', { key, check: 'missing' });
	const bytes = new Uint8Array(await (o as R2ObjectBody).arrayBuffer());
	if (bytes.length !== size) refuse(410, 'integrity', { key, check: 'size' });
	if ((await sha256Hex(bytes)) !== sha) refuse(410, 'integrity', { key, check: 'sha256' });
	return bytes;
}

// ----- user work (P4) -----

const uwTables = async (ctx: Ctx) => {
	const names = (await ctx.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'uw\\_%' ESCAPE '\\' ORDER BY name")).map((r) => r.name);
	for (const n of names) if (!/^uw_[a-z_]+$/.test(n)) refuse(500, 'unexpected-table');
	return names;
};
const columnsOf = async (ctx: Ctx, table: string) => (await ctx.db.all<{ name: string }>('SELECT name FROM pragma_table_info(?) ORDER BY cid', table)).map((r) => r.name);

async function snapshot(ctx: Ctx, caseId: string) {
	const tables: Record<string, { columns: string[]; rows: Row[] }> = {};
	for (const t of await uwTables(ctx)) {
		const columns = await columnsOf(ctx, t);
		const rows = await ctx.db.all(`SELECT * FROM ${t} WHERE case_id = ? ORDER BY ${columns.map((_, i) => i + 1).join(', ')}`, caseId);
		tables[t] = { columns, rows };
	}
	const rev = (await ctx.db.first<{ rev: number }>('SELECT rev FROM case_rev WHERE case_id = ?', caseId))?.rev ?? 0;
	return { format: 'clearcase.user-work/1', caseId, rev, tables };
}

async function backup(ctx: Ctx, caseId: string, label: string, snap: Awaited<ReturnType<typeof snapshot>>) {
	const text = JSON.stringify(snap);
	const sha = await sha256Hex(text);
	const key = `backup/${caseId}/${label}-${snap.rev}-${sha}.json`;
	await ctx.bucket.put(key, text, { sha256: sha, customMetadata: { client: ctx.client } });
	return { key, sha256: sha, size: new TextEncoder().encode(text).length };
}

async function registerWrite(ctx: Ctx, request: Request, caseId: string, store: string, op: string): Promise<Response> {
	const b = await body(request);
	const version = crypto.randomUUID();
	if (op === 'add') {
		const fields = JSON.stringify(field(b, 'fields', isObject));
		const operationId = field(b, 'operationId', isText(ID));
		const rowId = crypto.randomUUID();
		try {
			const out = await ctx.db.batch([
				['INSERT INTO case_rev (case_id, rev) VALUES (?, 0) ON CONFLICT (case_id) DO NOTHING', [caseId]],
				['UPDATE case_rev SET rev = rev + 1 WHERE case_id = ?', [caseId]],
				['INSERT INTO uw_register_row (case_id, store, row_id, seq, version, fields, operation_id) SELECT ?, ?, ?, coalesce(max(seq), 0) + 1, ?, ?, ? FROM uw_register_row WHERE case_id = ? AND store = ?', [caseId, store, rowId, version, fields, operationId, caseId, store]],
				['SELECT r.seq, c.rev FROM uw_register_row r JOIN case_rev c ON c.case_id = r.case_id WHERE r.case_id = ? AND r.row_id = ?', [caseId, rowId]],
			]);
			const r = out[3]!.results[0] as { seq: number; rev: number };
			return json(ctx, { kind: 'written', rowId, seq: r.seq, rev: r.rev, version, repeated: false });
		} catch (e) {
			if (!/UNIQUE constraint failed: uw_register_row\.case_id, uw_register_row\.operation_id/.test(String(e))) throw e;
			const r = await ctx.db.first<{ row_id: string; seq: number }>('SELECT row_id, seq FROM uw_register_row WHERE case_id = ? AND operation_id = ?', caseId, operationId);
			return json(ctx, { kind: 'written', rowId: r!.row_id, seq: r!.seq, repeated: true });
		}
	}
	if (op === 'naive-add') {
		// The control: read, then write, as two statements. Nothing stops two writers taking the same seq.
		const next = (await ctx.db.first<{ next: number }>('SELECT coalesce(max(seq), 0) + 1 AS next FROM probe_naive_seq WHERE case_id = ? AND store = ?', caseId, store))!.next;
		await ctx.db.batch([['INSERT INTO probe_naive_seq (case_id, store, seq) VALUES (?, ?, ?)', [caseId, store, next]]]);
		return json(ctx, { seq: next });
	}
	const rowId = field(b, 'rowId', isText(/^[0-9a-f-]{36}$/));
	const expected = field(b, 'expected', isText(/^[0-9a-f-]{36}$/));
	const write: [string, D1Value[]] = op === 'replace' ? ['UPDATE uw_register_row SET fields = ?, version = ? WHERE case_id = ? AND row_id = ?', [JSON.stringify(field(b, 'fields', isObject)), version, caseId, rowId]] : op === 'remove' ? ['DELETE FROM uw_register_row WHERE case_id = ? AND row_id = ?', [caseId, rowId]] : refuse(404, 'not-found');
	try {
		const out = await ctx.db.batch([guard('EXISTS (SELECT 1 FROM uw_register_row WHERE case_id = ? AND store = ? AND row_id = ? AND version = ?)', caseId, store, rowId, expected), ['UPDATE case_rev SET rev = rev + 1 WHERE case_id = ?', [caseId]], write, ['SELECT rev FROM case_rev WHERE case_id = ?', [caseId]], CLEAR]);
		return json(ctx, { kind: 'written', rev: (out[3]!.results[0] as { rev: number }).rev, version: op === 'replace' ? version : null });
	} catch (e) {
		if (!(e instanceof GuardFailed)) throw e;
		const exists = await ctx.db.first('SELECT 1 AS x FROM uw_register_row WHERE case_id = ? AND store = ? AND row_id = ?', caseId, store, rowId);
		return json(ctx, { kind: exists ? 'stale' : 'gone' }, 409);
	}
}

async function restoreStatements(ctx: Ctx, caseId: string, snap: Row, expectedRev: number, fail: boolean): Promise<[string, D1Value[]][]> {
	if (snap.format !== 'clearcase.user-work/1' || snap.caseId !== caseId || !isObject(snap.tables)) refuse(422, 'invalid-snapshot');
	const have = await uwTables(ctx);
	const given = Object.keys(snap.tables as Row);
	for (const t of have) if (!given.includes(t)) refuse(422, 'snapshot-incomplete', { table: t });
	for (const t of given) if (!have.includes(t)) refuse(422, 'snapshot-unknown-table', { table: t });
	const statements: [string, D1Value[]][] = [['INSERT INTO case_rev (case_id, rev) VALUES (?, 0) ON CONFLICT (case_id) DO NOTHING', [caseId]], guard('(SELECT rev FROM case_rev WHERE case_id = ?) = ?', caseId, expectedRev), ['UPDATE case_rev SET rev = rev + 1 WHERE case_id = ?', [caseId]]];
	for (const t of have) statements.push([`DELETE FROM ${t} WHERE case_id = ?`, [caseId]]);
	if (fail) statements.push(FAIL);
	for (const t of have) {
		const columns = await columnsOf(ctx, t);
		const entry = (snap.tables as Row)[t];
		if (!isObject(entry) || JSON.stringify(entry.columns) !== JSON.stringify(columns) || !isRows(entry.rows)) refuse(422, 'snapshot-columns-differ', { table: t });
		const list = (entry as { rows: Row[] }).rows;
		for (const r of list) if (JSON.stringify(Object.keys(r).sort()) !== JSON.stringify([...columns].sort()) || r.case_id !== caseId) refuse(422, 'snapshot-row-invalid', { table: t });
		statements.push(...inserts(t, columns, list, 'json', null));
	}
	statements.push(['SELECT rev FROM case_rev WHERE case_id = ?', [caseId]], CLEAR);
	return statements;
}

async function restore(ctx: Ctx, request: Request, caseId: string): Promise<Response> {
	const b = await body(request);
	const expectedRev = field(b, 'expectedRev', isCount);
	const snap = field(b, 'snapshot', isObject);
	const statements = await restoreStatements(ctx, caseId, snap, expectedRev, b.failAfterDelete === true);
	const pre = await backup(ctx, caseId, 'pre-restore', await snapshot(ctx, caseId)); // durable before any D1 write
	try {
		const out = await ctx.db.batch(statements);
		return json(ctx, { kind: 'written', rev: (out.at(-2)!.results[0] as { rev: number }).rev, preRestore: pre.key });
	} catch (e) {
		if (!(e instanceof GuardFailed)) throw e;
		const rev = (await ctx.db.first<{ rev: number }>('SELECT rev FROM case_rev WHERE case_id = ?', caseId))?.rev ?? 0;
		return json(ctx, { kind: rev === expectedRev ? 'rolled-back' : 'stale', rev, preRestore: pre.key }, 409);
	}
}

// ----- export packet (P7) -----

type PlanEntry = { path: string; source: string; sha256: string; size: number; kind: 'manifest' | 'user-work' | 'read-model' | 'results' | 'package' | 'list' | 'original' };

async function caseState(ctx: Ctx, caseId: string) {
	const active = await activeVersion(ctx, caseId);
	if (!active) refuse(404, 'no-active-version');
	const v = active!.version_id;
	const version = await ctx.db.first("SELECT version_id, case_id, state, expected_documents, expected_assets, expected_seeds, expected_files, list_sha256, list_size FROM results_version WHERE version_id = ?", v);
	const files = await ctx.db.all('SELECT path, sha256, size FROM package_file WHERE version_id = ? ORDER BY path', v);
	const originals = await ctx.db.all('SELECT c.asset_id, c.sha256, c.filename, c.media_type, o.size FROM case_original c JOIN original o ON o.sha256 = c.sha256 WHERE c.case_id = ? ORDER BY c.asset_id', caseId);
	const readModel: Record<Table, Row[]> = { document: [], asset: [], seed: [] };
	for (const t of Object.keys(TABLES) as Table[]) readModel[t] = await ctx.db.all(`SELECT ${TABLES[t].join(', ')} FROM ${t} WHERE version_id = ? ORDER BY 1`, v);
	return { v, version: version!, files: files as { path: string; sha256: string; size: number }[], originals: originals as { asset_id: string; sha256: string; filename: string; media_type: string; size: number }[], readModel, work: await snapshot(ctx, caseId) };
}

async function startExport(ctx: Ctx, caseId: string): Promise<Response> {
	const s = await caseState(ctx, caseId);
	const exportId = crypto.randomUUID();
	const base = `export/${caseId}/${exportId}`;
	const generated: [string, PlanEntry['kind'], string][] = [
		['user-work.json', 'user-work', JSON.stringify(s.work)],
		...(Object.keys(TABLES) as Table[]).map((t): [string, PlanEntry['kind'], string] => [`read-model/${t}.json`, 'read-model', JSON.stringify(s.readModel[t])]),
		['results/version.json', 'results', JSON.stringify({ version: s.version, packageFiles: s.files, originals: s.originals })],
	];
	const entries: PlanEntry[] = [];
	for (const [path, kind, text] of generated) {
		const sha = await sha256Hex(text);
		await ctx.bucket.put(`${base}/gen/${path}`, text, { sha256: sha });
		entries.push({ path, source: `${base}/gen/${path}`, sha256: sha, size: new TextEncoder().encode(text).length, kind });
	}
	for (const f of s.files) entries.push({ path: `package/${f.path}`, source: `pkg/${s.v}/${f.path}`, sha256: f.sha256, size: f.size, kind: 'package' });
	entries.push({ path: 'list/chronology.json', source: `rm/${s.v}/chronology.json`, sha256: s.version.list_sha256 as string, size: s.version.list_size as number, kind: 'list' });
	const seen = new Set<string>();
	for (const o of s.originals) if (!seen.has(o.sha256)) (seen.add(o.sha256), entries.push({ path: `originals/${o.sha256}`, source: `orig/${o.sha256}`, sha256: o.sha256, size: o.size, kind: 'original' }));
	const manifest = JSON.stringify({ format: BACKUP_FORMAT, client: ctx.client, caseId, resultsVersion: s.v, entries: entries.map(({ source: _, ...e }) => e) });
	const manifestSha = await sha256Hex(manifest);
	await ctx.bucket.put(`${base}/gen/manifest.json`, manifest, { sha256: manifestSha });
	entries.unshift({ path: 'manifest.json', source: `${base}/gen/manifest.json`, sha256: manifestSha, size: new TextEncoder().encode(manifest).length, kind: 'manifest' });
	const upload = await ctx.bucket.createMultipartUpload(`${base}.zip`, { customMetadata: { client: ctx.client } });
	await ctx.db.batch([["INSERT INTO export_job (export_id, case_id, version_id, state, object_key, upload_id, next_entry, next_offset, parts, plan) VALUES (?, ?, ?, 'building', ?, ?, 0, 0, '[]', ?)", [exportId, caseId, s.v, `${base}.zip`, upload.uploadId, JSON.stringify(entries)]]]);
	return json(ctx, { exportId, entries: entries.length, bytes: entries.reduce((n, e) => n + e.size, 0) });
}

type Job = { export_id: string; case_id: string; state: string; object_key: string; upload_id: string; next_entry: number; next_offset: number; parts: string; entry_state: string | null; plan: string; size: number | null; sha256: string | null; failure: string | null };

async function failExport(ctx: Ctx, job: Job, failure: string) {
	await ctx.bucket.resumeMultipartUpload(job.object_key, job.upload_id).abort().catch(() => undefined);
	await cleanGenerated(ctx, job);
	await ctx.db.batch([["UPDATE export_job SET state = 'failed', failure = ? WHERE export_id = ?", [failure, job.export_id]]]);
}
async function cleanGenerated(ctx: Ctx, job: Job) {
	const keys = (JSON.parse(job.plan) as PlanEntry[]).filter((e) => e.source.startsWith(`${job.object_key.slice(0, -4)}/gen/`)).map((e) => e.source);
	if (keys.length) await ctx.bucket.delete(keys);
}

/** Where each entry starts in the packet (local header, data, 16-byte descriptor), where the trailer starts, and the packet's size. */
function packetLayout(plan: PlanEntry[]) {
	const at: number[] = [];
	let o = 0;
	for (const e of plan) (at.push(o), (o += localHeaderSize(e.path) + e.size + DESCRIPTOR_SIZE));
	const trailerSize = trailer(plan.map((e, i) => ({ path: e.path, crc: 0, size: e.size, offset: at[i]! })), o).length;
	return { at, entriesEnd: o, total: o + trailerSize };
}

/** The entry being written when a step ends: its index and its running SHA-256 and CRC-32. */
type InFlight = { index: number; sha: Sha256State; crc: number };

async function exportStep(ctx: Ctx, caseId: string, exportId: string): Promise<Response> {
	const job = await ctx.db.first<Job>('SELECT * FROM export_job WHERE export_id = ? AND case_id = ?', exportId, caseId);
	if (!job) refuse(404, 'not-found');
	if (job!.state !== 'building') refuse(409, `export-${job!.state}`);
	if (job!.size !== null) refuse(409, 'export-written');
	const j = job!;
	const plan = JSON.parse(j.plan) as PlanEntry[];
	const parts = JSON.parse(j.parts) as R2UploadedPart[];
	const { at, entriesEnd, total } = packetLayout(plan);
	// The step writes packet bytes [start, end) as one part. R2 needs every part but the last to be the same size, so an
	// entry may span parts; its running hash and CRC carry over in entry_state.
	const start = parts.length * PART;
	const end = Math.min(start + PART, total);
	const upload = ctx.bucket.resumeMultipartUpload(j.object_key, j.upload_id);
	const fls = fixedLength(end - start);
	const part = upload.uploadPart(parts.length + 1, fls.readable);
	part.catch(() => undefined);
	const w = fls.writable.getWriter();
	const saved = j.entry_state ? (JSON.parse(j.entry_state) as InFlight) : null;
	let flight: { index: number; sha: Sha256; crc: number } | null = saved ? { index: saved.index, sha: new Sha256(saved.sha), crc: saved.crc } : null;
	const written: (Entry & { idx: number })[] = [];
	const crcOf = async (i: number) => written.find((x) => x.idx === i)?.crc ?? (await ctx.db.first<{ crc: number }>('SELECT crc FROM export_entry WHERE export_id = ? AND idx = ?', exportId, i))!.crc;
	const inFlight = (i: number) => {
		if (flight?.index !== i) throw new Error(`export ${exportId}: entry ${i} has no running hash`);
		return flight;
	};
	let pos = start;
	try {
		while (pos < end) {
			if (pos >= entriesEnd) {
				const before = await ctx.db.all<Entry>('SELECT path, crc, size, offset_bytes AS "offset" FROM export_entry WHERE export_id = ? ORDER BY idx', exportId);
				const tail = trailer([...before, ...written.map(({ idx: _, ...e }) => e)], entriesEnd);
				await w.write(tail.subarray(pos - entriesEnd, end - entriesEnd));
				pos = end;
				break;
			}
			let i = 0;
			for (let hi = at.length - 1; i < hi; ) {
				const mid = (i + hi + 1) >> 1;
				if (at[mid]! <= pos) i = mid;
				else hi = mid - 1;
			}
			const e = plan[i]!;
			const changed = () => refuse(410, e.kind === 'original' ? 'changed-original' : 'integrity', { key: e.source });
			const header = localHeader(e.path);
			const dataAt = at[i]! + header.length;
			const descAt = dataAt + e.size;
			if (pos < dataAt) {
				if (pos === at[i]) flight = { index: i, sha: new Sha256(), crc: 0 };
				const n = Math.min(dataAt, end) - pos;
				await w.write(header.subarray(pos - at[i]!, pos - at[i]! + n));
				pos += n;
			} else if (pos < descAt) {
				const f = inFlight(i);
				const from = pos - dataAt;
				const n = Math.min(descAt, end) - pos;
				const object = await ctx.bucket.get(e.source, { range: { offset: from, length: n } });
				if (!hasBody(object) || object.size !== e.size) changed();
				let got = 0;
				for await (const chunk of (object as R2ObjectBody).body) {
					f.sha.update(chunk);
					f.crc = crc32(chunk, f.crc);
					got += chunk.length;
					await w.write(chunk);
				}
				if (got !== n) changed();
				pos += n;
			} else {
				if (pos === descAt) {
					// The entry's last byte is in: unless its bytes are the ones recorded, this part and the upload are aborted,
					// so no packet holding them completes.
					const f = inFlight(i);
					if (f.sha.hex() !== e.sha256) changed();
					written.push({ idx: i, path: e.path, crc: f.crc, size: e.size, offset: at[i]! });
					flight = null;
				}
				const d = descriptor(await crcOf(i), e.size);
				const n = Math.min(descAt + DESCRIPTOR_SIZE, end) - pos;
				await w.write(d.subarray(pos - descAt, pos - descAt + n));
				pos += n;
			}
		}
		await w.close();
		parts.push(await part);
	} catch (err) {
		await w.abort(String(err)).catch(() => undefined);
		if (err instanceof Refused) await failExport(ctx, j, `${err.code}: ${String(err.detail.key ?? '')}`);
		throw err;
	}
	const complete = end === total;
	if (complete) await upload.complete(parts);
	const next = written.length ? written.at(-1)!.idx + 1 : j.next_entry;
	try {
		await ctx.db.batch([
			guard('EXISTS (SELECT 1 FROM export_job WHERE export_id = ? AND parts = ?)', exportId, j.parts),
			...inserts('export_entry', ['idx', 'path', 'crc', 'size', 'offset_bytes'], written.map((x) => ({ idx: x.idx, path: x.path, crc: x.crc, size: x.size, offset_bytes: x.offset })), 'json', { column: 'export_id', value: exportId }),
			['UPDATE export_job SET next_entry = ?, next_offset = ?, parts = ?, entry_state = ?, size = ? WHERE export_id = ?', [next, end, JSON.stringify(parts), flight ? JSON.stringify({ index: flight.index, sha: flight.sha.state(), crc: flight.crc }) : null, complete ? total : null, exportId]],
			CLEAR,
		]);
	} catch (e) {
		if (e instanceof GuardFailed) refuse(409, 'stale-step');
		throw e;
	}
	return json(ctx, { next, of: plan.length, parts: parts.length, complete });
}

async function sealExport(ctx: Ctx, caseId: string, exportId: string): Promise<Response> {
	const job = await ctx.db.first<Job>('SELECT * FROM export_job WHERE export_id = ? AND case_id = ?', exportId, caseId);
	if (!job || job.state !== 'building' || job.size === null) refuse(409, 'not-complete');
	const o = await ctx.bucket.get(job!.object_key);
	if (!hasBody(o) || (o as R2ObjectBody).size !== job!.size) refuse(410, 'integrity', { key: job!.object_key });
	const ds = digestStream();
	await (o as R2ObjectBody).body.pipeTo(ds);
	const sha = hex(await ds.digest);
	await cleanGenerated(ctx, job!);
	await ctx.db.batch([["UPDATE export_job SET state = 'complete', sha256 = ? WHERE export_id = ?", [sha, exportId]]]);
	return json(ctx, { complete: true, size: job!.size, sha256: sha, key: job!.object_key });
}

async function downloadExport(ctx: Ctx, caseId: string, exportId: string): Promise<Response> {
	const job = await ctx.db.first<Job>("SELECT * FROM export_job WHERE export_id = ? AND case_id = ? AND state = 'complete'", exportId, caseId);
	if (!job) return json(ctx, { code: 'not-found' }, 404);
	const etag = await hashWhole(ctx, job.object_key, job.sha256!, job.size!);
	const again = await ctx.bucket.get(job.object_key, { onlyIf: { etagMatches: etag } });
	if (!hasBody(again)) refuse(410, 'integrity', { key: job.object_key });
	// Hashed again as it streams, its last chunk held until the digest matches: the same rule as a large original.
	return new Response(verifiedStream((again as R2ObjectBody).body, job.sha256!, job.size!, 0, job.size! - 1), { headers: { ...NO_STORE, 'content-type': 'application/zip', 'content-length': String(job.size), 'x-packet-sha256': job.sha256!, ...probeHeaders(ctx) } });
}

// ----- restore from a packet (P7) -----

type Manifest = { format: string; client: string; caseId: string; resultsVersion: string; entries: Omit<PlanEntry, 'source'>[] };
const KINDS = new Set(['manifest', 'user-work', 'read-model', 'results', 'package', 'list', 'original']);
const DOT_SEGMENT = /(^|\/)\.\.?(\/|$)/;

/** The manifest, with every field the restore uses checked for its shape; anything else is a refusal, never a default. */
function readManifest(text: string): Manifest {
	const bad = (reason: string): never => refuse(422, 'invalid-packet', { reason });
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return bad('the manifest is not JSON');
	}
	if (!isObject(value) || typeof value.format !== 'string' || typeof value.client !== 'string' || !isText(ID)(value.caseId) || !isText(VERSION)(value.resultsVersion) || !Array.isArray(value.entries)) return bad('the manifest lacks a field');
	const entries = value.entries.map((e: unknown): Omit<PlanEntry, 'source'> => {
		if (!isObject(e) || typeof e.path !== 'string' || !isText(SHA)(e.sha256) || !isCount(e.size) || typeof e.kind !== 'string' || !KINDS.has(e.kind)) return bad('a manifest entry lacks a field');
		if (e.kind === 'package' && !(e.path.startsWith('package/') && PATH.test(e.path.slice('package/'.length)) && !DOT_SEGMENT.test(e.path))) return bad('a package entry has an unusable path');
		return e as unknown as Omit<PlanEntry, 'source'>;
	});
	return { format: value.format, client: value.client, caseId: value.caseId, resultsVersion: value.resultsVersion, entries };
}

/** Opens a backup of the case the request names: any other client or case is refused before anything else is read. */
async function packetDirectory(ctx: Ctx, key: string, caseId: string) {
	const head = await ctx.bucket.head(key);
	if (!head) refuse(404, 'not-found');
	const size = head!.size;
	const tailLength = Math.min(size, 1024);
	const tail = await ctx.bucket.get(key, { range: { offset: size - tailLength, length: tailLength } });
	if (!hasBody(tail)) refuse(410, 'integrity');
	let loc: ReturnType<typeof locate>;
	let entries: Entry[];
	try {
		loc = locate(new Uint8Array(await (tail as R2ObjectBody).arrayBuffer()));
		const cd = await ctx.bucket.get(key, { range: { offset: loc.offset, length: loc.size } });
		if (!hasBody(cd)) refuse(410, 'integrity');
		entries = centralDirectory(new Uint8Array(await (cd as R2ObjectBody).arrayBuffer()), loc.count);
	} catch (e) {
		if (e instanceof Refused) throw e;
		refuse(422, 'invalid-packet', { reason: String((e as Error).message) });
	}
	if (entries![0]?.path !== 'manifest.json') refuse(422, 'invalid-packet', { reason: 'the first entry is not manifest.json' });
	const manifestBytes = await entryBytes(ctx, key, entries![0]!);
	if (crc32(manifestBytes) !== entries![0]!.crc) refuse(422, 'invalid-packet', { reason: 'manifest CRC' });
	const manifest = readManifest(new TextDecoder().decode(manifestBytes));
	if (manifest.format !== BACKUP_FORMAT) refuse(422, 'invalid-packet', { reason: 'format' });
	if (manifest.client !== ctx.client) refuse(409, 'wrong-client');
	if (manifest.caseId !== caseId) refuse(409, 'wrong-case');
	const listed = manifest.entries.map((e) => `${e.path}:${e.size}`).join('\n');
	const present = entries!.slice(1).map((e) => `${e.path}:${e.size}`).join('\n');
	if (listed !== present) refuse(422, 'invalid-packet', { reason: 'the manifest does not list exactly the entries present' });
	return { entries: entries!, manifest };
}

async function entryBytes(ctx: Ctx, key: string, e: Entry): Promise<Uint8Array> {
	const n = new TextEncoder().encode(e.path).length;
	const r = await ctx.bucket.get(key, { range: { offset: e.offset, length: 30 + n + e.size } });
	if (!hasBody(r)) refuse(410, 'integrity');
	const all = new Uint8Array(await (r as R2ObjectBody).arrayBuffer());
	const at = checkLocal(all, e.path);
	return all.subarray(at, at + e.size);
}

const restoreTarget = (m: Omit<PlanEntry, 'source'>, resultsVersion: string) =>
	m.kind === 'original' ? `orig/${m.sha256}` : m.kind === 'package' ? `pkg/${resultsVersion}/${m.path.slice('package/'.length)}` : m.kind === 'list' ? `rm/${resultsVersion}/chronology.json` : null;

/** A restore stages a version that is new, or its own case's unfinished one, in a case with no active version; nothing else. */
async function restorable(ctx: Ctx, caseId: string, v: string) {
	const row = await ctx.db.first<{ case_id: string; state: string }>('SELECT case_id, state FROM results_version WHERE version_id = ?', v);
	if (row && row.case_id !== caseId) refuse(409, 'version-of-another-case');
	if (row?.state === 'stored') refuse(409, 'already-restored');
	if (await activeVersion(ctx, caseId)) refuse(409, 'case-live');
}

async function restoreStep(ctx: Ctx, request: Request, packetId: string): Promise<Response> {
	const b = await body(request);
	const caseId = field(b, 'caseId', isText(ID));
	const from = field(b, 'from', isCount);
	const key = `import/${packetId}.zip`;
	const { entries, manifest } = await packetDirectory(ctx, key, caseId);
	await restorable(ctx, caseId, manifest.resultsVersion);
	let i = Math.max(1, from);
	let bytes = 0;
	while (i < entries.length && bytes < RESTORE_STEP_BYTES) {
		const e = entries[i]!;
		const m = manifest.entries[i - 1]!;
		const target = restoreTarget(m, manifest.resultsVersion);
		if (target) {
			// Write-once: bytes already there that are these ones are a repeat of an earlier step; anything else is left as it is.
			const stored = await ctx.bucket.head(target);
			if (stored && (stored.size !== m.size || checksum(stored) !== m.sha256)) refuse(409, 'conflicting-object', { entry: e.path });
			const n = new TextEncoder().encode(e.path).length;
			const head = await ctx.bucket.get(key, { range: { offset: e.offset, length: 30 + n } });
			if (!hasBody(head)) refuse(410, 'integrity');
			checkLocal(new Uint8Array(await (head as R2ObjectBody).arrayBuffer()), e.path);
			// The archive's CRC-32 is checked over the whole entry before a byte is written, so a mismatch has written nothing.
			const first = await ctx.bucket.get(key, { range: { offset: e.offset + 30 + n, length: e.size } });
			if (!hasBody(first)) refuse(410, 'integrity');
			let crc = 0;
			for await (const chunk of (first as R2ObjectBody).body) crc = crc32(chunk, crc);
			if (crc !== e.crc) refuse(422, 'crc-mismatch', { entry: e.path });
			if (!stored) {
				const data = await ctx.bucket.get(key, { range: { offset: e.offset + 30 + n, length: e.size } });
				if (!hasBody(data)) refuse(410, 'integrity');
				const fls = fixedLength(e.size);
				const piped = (data as R2ObjectBody).body.pipeTo(fls.writable);
				try {
					// R2 refuses the PUT, and stores nothing, unless the bytes match the manifest's SHA-256
					await Promise.all([ctx.bucket.put(target, fls.readable, { sha256: m.sha256, customMetadata: { client: ctx.client } }), piped]);
				} catch (err) {
					if (/SHA-256/i.test(String(err))) refuse(422, 'digest-mismatch', { entry: e.path });
					throw err;
				}
			}
			bytes += e.size;
		}
		i++;
	}
	return json(ctx, { next: i, of: entries.length });
}

/** A field of the backup's own records: missing, null or retyped is a refusal naming it. */
function recorded<T>(o: Row, name: string, where: string, ok: (v: unknown) => v is T): T {
	return ok(o[name]) ? (o[name] as T) : refuse(422, 'invalid-packet', { reason: `${where}.${name}` });
}

async function restoreFinish(ctx: Ctx, request: Request, packetId: string): Promise<Response> {
	const caseId = field(await body(request), 'caseId', isText(ID));
	const key = `import/${packetId}.zip`;
	const { entries, manifest } = await packetDirectory(ctx, key, caseId);
	const v = manifest.resultsVersion;
	await restorable(ctx, caseId, v);
	const read = async (path: string) => {
		const k = entries.findIndex((e) => e.path === path);
		if (k < 1) refuse(422, 'invalid-packet', { reason: `no ${path}` });
		const bytes = await entryBytes(ctx, key, entries[k]!);
		if ((await sha256Hex(bytes)) !== manifest.entries[k - 1]!.sha256 || crc32(bytes) !== entries[k]!.crc) refuse(422, 'digest-mismatch', { entry: path });
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	};
	const readObject = async (path: string) => {
		const x = await read(path);
		return isObject(x) ? x : refuse(422, 'invalid-packet', { reason: path });
	};
	const readRows = async (path: string) => {
		const x = await read(path);
		return isRows(x) ? x : refuse(422, 'invalid-packet', { reason: path });
	};
	for (const m of manifest.entries) {
		const target = restoreTarget(m, v);
		if (!target) continue;
		const o = await ctx.bucket.head(target);
		if (!o || o.size !== m.size || checksum(o) !== m.sha256) refuse(409, 'incomplete', { missing: target });
	}

	// Everything the restore will write is read and checked here, before the first write: a refusal leaves the case as it was.
	const results = await readObject('results/version.json');
	const version = recorded(results, 'version', 'results', isObject);
	if (version.version_id !== v || version.case_id !== caseId || version.state !== 'stored') refuse(422, 'invalid-packet', { reason: 'results/version.json' });
	const stage = {
		documents: recorded(version, 'expected_documents', 'version', isCount),
		assets: recorded(version, 'expected_assets', 'version', isCount),
		seeds: recorded(version, 'expected_seeds', 'version', isCount),
		files: recorded(version, 'expected_files', 'version', isCount),
		list: { sha256: recorded(version, 'list_sha256', 'version', isText(SHA)), size: recorded(version, 'list_size', 'version', isCount) },
	};
	const files = recorded(results, 'packageFiles', 'results', isRows).map((f) => ({ path: recorded(f, 'path', 'packageFiles', isText(PATH)), sha256: recorded(f, 'sha256', 'packageFiles', isText(SHA)), size: recorded(f, 'size', 'packageFiles', isCount) }));
	const originals = recorded(results, 'originals', 'results', isRows).map((o) => ({
		asset_id: recorded(o, 'asset_id', 'originals', isText(ID)),
		sha256: recorded(o, 'sha256', 'originals', isText(SHA)),
		size: recorded(o, 'size', 'originals', isCount),
		filename: recorded(o, 'filename', 'originals', isText(/^[^/\\\0]{1,200}$/)),
		media_type: recorded(o, 'media_type', 'originals', isText(/^[a-z]+\/[a-z0-9.+-]+$/)),
	}));
	const packaged = new Map(manifest.entries.filter((e) => e.kind === 'original').map((e) => [e.sha256, e.size]));
	for (const o of originals) if (packaged.get(o.sha256) !== o.size) refuse(422, 'invalid-packet', { reason: 'an original record has no such entry in the backup' });
	const bound = new Map((await ctx.db.all<{ asset_id: string; sha256: string }>('SELECT asset_id, sha256 FROM case_original WHERE case_id = ?', caseId)).map((r) => [r.asset_id, r.sha256]));
	for (const o of originals) if (bound.has(o.asset_id) && bound.get(o.asset_id) !== o.sha256) refuse(409, 'asset-bound-to-another-original');
	const model: Record<Table, Row[]> = { document: await readRows('read-model/document.json'), asset: await readRows('read-model/asset.json'), seed: await readRows('read-model/seed.json') };
	for (const t of Object.keys(TABLES) as Table[]) for (const r of model[t]) for (const c of TABLES[t]) if (!(c in r)) refuse(422, 'invalid-packet', { reason: `read-model/${t}.json lacks ${c}` });
	await verifyObjects(ctx, v, stage.list, files);
	const rev = (await ctx.db.first<{ rev: number }>('SELECT rev FROM case_rev WHERE case_id = ?', caseId))?.rev ?? 0;
	const userWork = await restoreStatements(ctx, caseId, await readObject('user-work.json'), rev, false);

	const pre = await backup(ctx, caseId, 'pre-restore', await snapshot(ctx, caseId)); // durable before any D1 write
	// The same staged path as an import. The version flips to stored, and the case to active, last and in one batch: a
	// refusal or a crash before it leaves a staging version that a retry of this call rebuilds.
	await ctx.db.batch([["INSERT INTO results_version (version_id, case_id, state, attempt, expected_documents, expected_assets, expected_seeds, expected_files, list_sha256, list_size) VALUES (?, ?, 'staging', 1, ?, ?, ?, ?, ?, ?) ON CONFLICT (version_id) DO UPDATE SET expected_documents = excluded.expected_documents, expected_assets = excluded.expected_assets, expected_seeds = excluded.expected_seeds, expected_files = excluded.expected_files, list_sha256 = excluded.list_sha256, list_size = excluded.list_size WHERE results_version.state = 'staging' AND results_version.case_id = excluded.case_id", [v, caseId, stage.documents, stage.assets, stage.seeds, stage.files, stage.list.sha256, stage.list.size]]]);
	for (const t of Object.keys(TABLES) as Table[]) await ctx.db.batch([staging(v, caseId), [`DELETE FROM ${t} WHERE version_id = ?`, [v]], ...inserts(t, TABLES[t], model[t], 'json', { column: 'version_id', value: v }), CLEAR]);
	await ctx.db.batch([staging(v, caseId), ['DELETE FROM package_file WHERE version_id = ?', [v]], ...inserts('package_file', ['path', 'sha256', 'size'], files, 'json', { column: 'version_id', value: v }), CLEAR]);
	const ignoring = (statements: [string, D1Value[]][]) => statements.map(([s, p]): [string, D1Value[]] => [`${s} WHERE true ON CONFLICT DO NOTHING`, p]);
	const originalRows = [...ignoring(inserts('original', ['sha256', 'size'], originals, 'json', null)), ...ignoring(inserts('case_original', ['case_id', 'asset_id', 'sha256', 'filename', 'media_type'], originals.map((o) => ({ asset_id: o.asset_id, sha256: o.sha256, filename: o.filename, media_type: o.media_type, case_id: caseId })), 'json', null))];
	if (originalRows.length) await ctx.db.batch(originalRows);
	try {
		await ctx.db.batch(userWork);
	} catch (e) {
		if (e instanceof GuardFailed) refuse(409, 'stale');
		throw e;
	}
	try {
		await ctx.db.batch([
			hasEveryRow(v, caseId),
			guard('NOT EXISTS (SELECT 1 FROM active WHERE case_id = ?)', caseId),
			["UPDATE results_version SET state = 'stored' WHERE version_id = ?", [v]],
			['INSERT INTO activation_log (case_id, seq, version_id, previous) SELECT ?, coalesce(max(seq), 0) + 1, ?, NULL FROM activation_log WHERE case_id = ?', [caseId, v, caseId]],
			['INSERT INTO active (case_id, version_id) VALUES (?, ?)', [caseId, v]],
			CLEAR,
		]);
	} catch (e) {
		if (!(e instanceof GuardFailed)) throw e;
		return (await activeVersion(ctx, caseId)) ? json(ctx, { code: 'case-live' }, 409) : incomplete(ctx, v);
	}
	return json(ctx, { restored: caseId, resultsVersion: v, entries: entries.length - 1, preRestore: pre });
}

/** What a case holds in D1, for the runner to compare before and after a refused restore. */
async function liveState(ctx: Ctx, caseId: string): Promise<Response> {
	const versions = await ctx.db.all('SELECT version_id, state FROM results_version WHERE case_id = ? ORDER BY version_id', caseId);
	const active = await ctx.db.first<{ version_id: string }>('SELECT version_id FROM active WHERE case_id = ?', caseId);
	const originals = (await ctx.db.first<{ n: number }>('SELECT count(*) AS n FROM case_original WHERE case_id = ?', caseId))!.n;
	const work = await snapshot(ctx, caseId);
	return json(ctx, { versions, active: active?.version_id ?? null, originals, rev: work.rev, work: Object.fromEntries(Object.entries(work.tables).map(([t, v]) => [t, v.rows.length])) });
}

/** A digest of everything stored for a case, to compare a restored deployment with its source. */
async function stateDigest(ctx: Ctx, caseId: string): Promise<Response> {
	const s = await caseState(ctx, caseId);
	const objects: [string, number][] = [];
	for (const key of [`rm/${s.v}/chronology.json`, ...s.files.map((f) => `pkg/${s.v}/${f.path}`), ...[...new Set(s.originals.map((o) => o.sha256))].map((sha) => `orig/${sha}`)]) {
		const o = await ctx.bucket.head(key);
		objects.push([key, o ? o.size : -1]);
	}
	const { rev: _, ...work } = s.work;
	const state = { version: s.version, files: s.files, originals: s.originals, readModel: s.readModel, work, objects: objects.sort() };
	return json(ctx, { sha256: await sha256Hex(JSON.stringify(state)), counts: { files: s.files.length, originals: s.originals.length, documents: s.readModel.document.length, assets: s.readModel.asset.length, seeds: s.readModel.seed.length, objects: objects.length, missing: objects.filter((o) => o[1] < 0).length } });
}

// ----- routing -----

async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
	const m = request.method;
	const ctx = await open(env);
	if (m === 'GET' && seg.length === 1 && seg[0] === 'identity') return json(ctx, { client: ctx.client, d1: ctx.client, r2: ctx.client });
	if (m === 'GET' && seg.length === 1 && seg[0] === 'd1-size') return json(ctx, { bytes: (await ctx.db.batch([['SELECT 1', []]]))[0]!.meta.size_after });
	// Read-only introspection for the runner: what an R2 key holds, and what a case holds in D1.
	if (m === 'GET' && seg[0] === 'probe' && seg[1] === 'head' && seg.length > 2) {
		const key = seg.slice(2).join('/');
		const o = /^(orig|pkg|rm|backup|preview)\//.test(key) ? await ctx.bucket.head(key) : null;
		return o ? json(ctx, { key, size: o.size, sha256: checksum(o), etag: o.etag }) : json(ctx, { code: 'not-found' }, 404);
	}
	if (m === 'GET' && seg[0] === 'probe' && seg[1] === 'live' && seg.length === 3 && isText(ID)(seg[2])) return liveState(ctx, seg[2]);
	if (seg[0] === 'originals' && isText(SHA)(seg[1])) {
		const sha = seg[1];
		if (m === 'PUT' && seg.length === 2) return putOriginal(ctx, request, sha);
		const key = `orig/${sha}`;
		if (m === 'POST' && seg.length === 3 && seg[2] === 'uploads') {
			if (await ctx.bucket.head(key)) refuse(409, 'conflicting-object');
			const u = await ctx.bucket.createMultipartUpload(key, { customMetadata: { client: ctx.client } });
			return json(ctx, { uploadId: u.uploadId });
		}
		if (seg.length === 5 && seg[2] === 'uploads' && m === 'PUT') {
			const length = Number(request.headers.get('content-length'));
			if (!request.body || !Number.isSafeInteger(length) || length > SINGLE_PUT_MAX) refuse(413, 'part-too-large');
			return json(ctx, await ctx.bucket.resumeMultipartUpload(key, seg[3]!).uploadPart(Number(seg[4]), request.body!));
		}
		if (seg.length === 5 && seg[2] === 'uploads' && seg[4] === 'complete' && m === 'POST') {
			const b = await body(request);
			const upload = ctx.bucket.resumeMultipartUpload(key, seg[3]!);
			// orig/<sha> is write-once: a complete would replace whatever a racing upload put there since this one began.
			if (await ctx.bucket.head(key)) {
				await upload.abort().catch(() => undefined);
				refuse(409, 'conflicting-object');
			}
			const o = await upload.complete(field(b, 'parts', (x): x is R2UploadedPart[] => Array.isArray(x)));
			return json(ctx, { size: o.size });
		}
	}
	if (seg[0] === 'restore' && seg[1] === 'packets') {
		if (m === 'POST' && seg.length === 2) {
			const packetId = crypto.randomUUID();
			const u = await ctx.bucket.createMultipartUpload(`import/${packetId}.zip`);
			return json(ctx, { packetId, uploadId: u.uploadId });
		}
		const packetId = isText(/^[0-9a-f-]{36}$/)(seg[2]) ? seg[2] : refuse(404, 'not-found');
		const key = `import/${packetId}.zip`;
		if (m === 'PUT' && seg.length === 5) return json(ctx, await ctx.bucket.resumeMultipartUpload(key, seg[3]!).uploadPart(Number(seg[4]), request.body!));
		if (m === 'POST' && seg.length === 5 && seg[4] === 'complete') {
			const b = await body(request);
			return json(ctx, { size: (await ctx.bucket.resumeMultipartUpload(key, seg[3]!).complete(field(b, 'parts', (x): x is R2UploadedPart[] => Array.isArray(x)))).size });
		}
		if (m === 'POST' && seg.length === 4 && seg[3] === 'open') {
			// A packet of another client is refused and not kept.
			const caseId = field(await body(request), 'caseId', isText(ID));
			const { entries, manifest } = await packetDirectory(ctx, key, caseId).catch(async (e: unknown) => {
				if (e instanceof Refused && e.code === 'wrong-client') await ctx.bucket.delete(key);
				throw e;
			});
			return json(ctx, { entries: entries.length, caseId: manifest.caseId, resultsVersion: manifest.resultsVersion });
		}
		if (m === 'POST' && seg.length === 4 && seg[3] === 'step') return restoreStep(ctx, request, packetId);
		if (m === 'POST' && seg.length === 4 && seg[3] === 'finish') return restoreFinish(ctx, request, packetId);
	}
	if (seg[0] === 'cases' && isText(ID)(seg[1])) {
		const caseId = seg[1];
		const rest = seg.slice(2);
		if (m === 'POST' && rest.join('/') === 'originals') return finalize(ctx, request, caseId);
		if ((m === 'GET' || m === 'HEAD') && rest[0] === 'originals' && rest.length === 2) return serveOriginal(ctx, request, caseId, rest[1]!);
		if (rest[0] === 'versions' && isText(VERSION)(rest[1])) {
			const v = rest[1];
			if (m === 'POST' && rest[2] === 'begin') return begin(ctx, request, caseId, v);
			if (m === 'POST' && rest[2] === 'rows') return rows(ctx, request, caseId, v);
			if (m === 'POST' && rest[2] === 'finish') return finish(ctx, caseId, v);
			if (m === 'PUT' && rest[2] === 'list') {
				const r = await ctx.db.first<{ list_sha256: string }>('SELECT list_sha256 FROM results_version WHERE version_id = ? AND case_id = ?', v, caseId);
				if (!r) refuse(409, 'not-staging');
				return putPackageObject(ctx, request, caseId, v, `rm/${v}/chronology.json`, r!.list_sha256, null);
			}
			const path = rest.slice(3).join('/');
			if (m === 'PUT' && rest[2] === 'files' && PATH.test(path)) {
				const sha = isText(SHA)(request.headers.get('x-sha256')) ? request.headers.get('x-sha256')! : refuse(400, 'invalid-field', { field: 'x-sha256' });
				const size = Number(request.headers.get('content-length'));
				return putPackageObject(ctx, request, caseId, v, `pkg/${v}/${path}`, sha, ['INSERT INTO package_file (version_id, path, sha256, size) VALUES (?, ?, ?, ?) ON CONFLICT (version_id, path) DO NOTHING', [v, path, sha, size]]);
			}
			if (m === 'GET' && rest[2] === 'files' && PATH.test(path)) {
				// Published namespace only: a candidate (stored but not active) version's files are not served.
				const f = await ctx.db.first<{ sha256: string; size: number }>('SELECT f.sha256, f.size FROM active a JOIN package_file f ON f.version_id = a.version_id WHERE a.case_id = ? AND a.version_id = ? AND f.path = ?', caseId, v, path);
				if (!f) return json(ctx, { code: 'not-found' }, 404);
				const bytes = await verifiedObject(ctx, `pkg/${v}/${path}`, f.sha256, f.size);
				return new Response(bytes, { headers: { ...NO_STORE, 'content-type': 'application/json', ...probeHeaders(ctx) } });
			}
			if (m === 'POST' && rest[2] === 'blob-arm') {
				// Layout arm: the same package files as D1 BLOBs, read back from R2 (verified) and written in one batch per file.
				const files = await ctx.db.all<{ path: string; sha256: string; size: number }>('SELECT path, sha256, size FROM package_file WHERE version_id = ? ORDER BY path', v);
				const before = (await ctx.db.batch([['SELECT 1', []]]))[0]!.meta.size_after;
				let after = before;
				for (const f of files) {
					const bytes = await verifiedObject(ctx, `pkg/${v}/${f.path}`, f.sha256, f.size);
					after = (await ctx.db.batch([['INSERT OR REPLACE INTO probe_package_blob (version_id, path, bytes) VALUES (?, ?, ?)', [v, f.path, bytes.buffer as ArrayBuffer]]]))[0]!.meta.size_after;
				}
				const largest = await ctx.db.first<{ n: number }>('SELECT max(length(bytes)) AS n FROM probe_package_blob WHERE version_id = ?', v);
				await ctx.db.batch([['DELETE FROM probe_package_blob WHERE version_id = ?', [v]]]);
				// What local D1 enforces of the documented limits: 100 bound parameters, 2,000,000 bytes per value.
				const outcome = (p: Promise<unknown>) => p.then(() => 'accepted', () => 'refused');
				const params101 = await outcome(ctx.db.all(`SELECT ${Array.from({ length: 101 }, () => '?').join(', ')}`, ...Array.from({ length: 101 }, (_, i) => i)));
				const over2MB = await outcome(ctx.db.all('SELECT length(?) AS n', 'x'.repeat(2_000_001)));
				return json(ctx, { files: files.length, d1BytesBefore: before, d1BytesAfter: after, largestValue: largest?.n ?? 0, limits: { params101, over2MB } });
			}
		}
		if (m === 'POST' && rest.join('/') === 'activate') return activate(ctx, request, caseId);
		if (m === 'GET' && rest[0] === 'documents' && rest.length === 2) {
			const d = await ctx.db.first<{ row_json: string }>('SELECT d.row_json FROM active a JOIN document d ON d.version_id = a.version_id WHERE a.case_id = ? AND d.ref = ?', caseId, rest[1]!);
			return d ? json(ctx, JSON.parse(d.row_json)) : json(ctx, { code: 'not-found' }, 404);
		}
		if (m === 'GET' && rest.join('/') === 'chronology') {
			const a = await activeVersion(ctx, caseId);
			if (!a) return json(ctx, { code: 'not-found' }, 404);
			const bytes = await verifiedObject(ctx, `rm/${a.version_id}/chronology.json`, a.list_sha256, a.list_size);
			return json(ctx, { resultsVersion: a.version_id, rows: (JSON.parse(new TextDecoder().decode(bytes)) as unknown[]).length });
		}
		if (m === 'GET' && rest.join('/') === 'verify') {
			// GRS-12's rule on first serve: every package file and the list of the active version, hashed whole.
			const a = await activeVersion(ctx, caseId);
			if (!a) return json(ctx, { code: 'not-found' }, 404);
			const files = await ctx.db.all<{ path: string; sha256: string; size: number }>('SELECT path, sha256, size FROM package_file WHERE version_id = ? ORDER BY path', a.version_id);
			let bytes = (await verifiedObject(ctx, `rm/${a.version_id}/chronology.json`, a.list_sha256, a.list_size)).length;
			for (const f of files) bytes += (await verifiedObject(ctx, `pkg/${a.version_id}/${f.path}`, f.sha256, f.size)).length;
			return json(ctx, { ok: true, files: files.length + 1, bytes });
		}
		if (rest[0] === 'registers' && isText(/^[a-z][a-z0-9-]{0,40}$/)(rest[1]) && rest.length === 3 && m === 'POST') return registerWrite(ctx, request, caseId, rest[1], rest[2]!);
		if (m === 'GET' && rest.join('/') === 'work') {
			const snap = await snapshot(ctx, caseId);
			return json(ctx, url.searchParams.get('backup') === '1' ? { ...snap, backup: await backup(ctx, caseId, 'snapshot', snap) } : snap);
		}
		if (m === 'POST' && rest.join('/') === 'work/restore') return restore(ctx, request, caseId);
		if (m === 'POST' && rest.join('/') === 'exports') return startExport(ctx, caseId);
		if (rest[0] === 'exports' && isText(/^[0-9a-f-]{36}$/)(rest[1])) {
			if (m === 'POST' && rest[2] === 'step') return exportStep(ctx, caseId, rest[1]);
			if (m === 'POST' && rest[2] === 'seal') return sealExport(ctx, caseId, rest[1]);
			if (m === 'GET' && rest.length === 2) return downloadExport(ctx, caseId, rest[1]);
			if (m === 'GET' && rest[2] === 'job') return json(ctx, await ctx.db.first('SELECT export_id, state, next_entry, size, sha256, failure FROM export_job WHERE export_id = ? AND case_id = ?', rest[1], caseId));
		}
		if (m === 'GET' && rest.join('/') === 'state') return stateDigest(ctx, caseId);
	}
	return json(ctx, { code: 'not-found' }, 404);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			return await route(request, env);
		} catch (e) {
			if (e instanceof Refused) return json(null, { code: e.code, ...e.detail }, e.status);
			return json(null, { code: 'internal', message: String(e instanceof Error ? e.message : e) }, 500);
		} finally {
			// A body the route did not read (a refusal, a repeated upload) is drained, or the client's connection breaks.
			if (request.body && !request.bodyUsed) await request.body.pipeTo(new WritableStream()).catch(() => undefined);
		}
	},
};
