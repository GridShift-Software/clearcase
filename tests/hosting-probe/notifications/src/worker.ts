// The notification probe's Worker (GRS-111): one client instance that publishes results or asks for input, and tells
// the case's uploader in the app and by one minimal email. Synthetic; not the product's route tree.
//
// Order of a publication: the results file goes to R2, then one D1 batch writes the publication, the in-app notice and
// its outbox row together, and only then is the email tried. Email never gates or rolls back what came before it: a
// failed, refused or hung send leaves the publication, the file and the in-app notice as they are, and the outbox row
// records the attempt for the operator. A cron sweep (`scheduled`) retries due rows up to MAX_ATTEMPTS. No Queues.
//
// Identity is a test double: the `x-probe-identity: <client>/<user>` header stands in for the client's Clerk session
// (GRS-108 owns Clerk). The link in the email carries only an opaque notice id; following it needs that identity.
import { composeNotice, noticeProblems, type Message, type NoticeKind } from './notice.ts';
import { classify, errorCode, MAX_ATTEMPTS, nextAttemptAt, type Outcome } from './policy.ts';

type Row = Record<string, unknown>;
type Stmt = { bind(...values: unknown[]): Stmt; first<T = Row>(): Promise<T | null>; all<T = Row>(): Promise<{ results: T[] }>; run(): Promise<{ meta: { changes: number } }> };
type D1 = { prepare(sql: string): Stmt; batch(statements: Stmt[]): Promise<unknown[]> };
type R2 = { put(key: string, value: string): Promise<unknown>; get(key: string): Promise<{ text(): Promise<string> } | null> };
type SendEmail = { send(message: Message): Promise<{ messageId?: unknown }> };
/** The source revision Bun stamps into the build (probe.ts); /health reports it. */
declare const PROBE_SOURCE_REVISION: string;

type Env = { DB: D1; BUCKET: R2; EMAIL?: SendEmail; CLIENT_ID: string; APP_ORIGIN: string; SENDER: string; SEND_TIMEOUT_MS?: string; FAULT_PLAN?: string };

/** An attempt still `sending` this long after its claim was cut off mid-send (the Worker died or timed out): acceptance unknown. */
const STALE_SENDING_MS = 10 * 60_000;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const refuse = (status: number, error: string) => json({ error }, status);

async function sha256(text: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The signed-in user of this client instance, or null. A session for another client is no session here. */
async function identity(req: Request, env: Env): Promise<{ id: string; role: string } | null> {
	const [client, user, extra] = (req.headers.get('x-probe-identity') ?? '').split('/');
	if (!client || !user || extra !== undefined || client !== env.CLIENT_ID) return null;
	return env.DB.prepare('SELECT id, role FROM users WHERE client = ? AND id = ?').bind(env.CLIENT_ID, user).first<{ id: string; role: string }>();
}

/**
 * The provider's send() for one attempt. With FAULT_PLAN (declared only by `wrangler.toml`'s `faults` environment, a
 * test double for the provider's failure responses) step n of the notice's plan replaces or follows the real call:
 * `E_*` throws that code without sending, `accepted-then:E_*` sends through the real binding and then throws (the
 * response was lost), `hang` never answers, and `pass` (or no step) is the real binding alone.
 */
function sender(env: Env, planKey: string, n: number): SendEmail | null {
	const real = env.EMAIL;
	if (!real) return null;
	if (env.FAULT_PLAN === undefined) return real;
	const step = (JSON.parse(env.FAULT_PLAN) as Record<string, string[]>)[planKey]?.[n - 1] ?? 'pass';
	const coded = (code: string) => Object.assign(new Error('injected provider failure'), { code });
	return {
		async send(message) {
			if (step === 'pass') return real.send(message);
			if (step === 'hang') return new Promise(() => {});
			if (step.startsWith('accepted-then:')) {
				await real.send(message);
				throw coded(step.slice('accepted-then:'.length));
			}
			throw coded(step);
		},
	};
}

/** One send attempt for the notice, if its outbox row is due and this call wins the claim; records the outcome either way. */
async function attempt(env: Env, noticeId: string, now: number): Promise<void> {
	const row = await env.DB.prepare(
		`SELECT o.attempts, o.state, n.kind, n.case_id, n.round, u.email, c.title, c.ref FROM outbox o JOIN notices n ON n.id = o.notice_id
		 JOIN cases c ON c.client = n.client AND c.id = n.case_id LEFT JOIN users u ON u.client = n.client AND u.id = n.recipient
		 WHERE o.notice_id = ? AND n.client = ?`,
	)
		.bind(noticeId, env.CLIENT_ID)
		.first<{ attempts: number; state: string; kind: NoticeKind; case_id: string; round: number; email: string | null; title: string; ref: string }>();
	if (!row || !['pending', 'retrying'].includes(row.state)) return;
	const n = row.attempts + 1;
	const claim = await env.DB.prepare("UPDATE outbox SET state = 'sending', attempts = ?, claimed_at = ?, updated_at = ? WHERE notice_id = ? AND attempts = ? AND state = ?")
		.bind(n, now, now, noticeId, row.attempts, row.state)
		.run();
	if (claim.meta.changes !== 1) return; // another invocation took this attempt

	let code: string | null = null;
	let messageId: string | null = null;
	const docs = await env.DB.prepare('SELECT title, filename FROM documents WHERE client = ? AND case_id = ?').bind(env.CLIENT_ID, row.case_id).all<{ title: string; filename: string }>();
	const forbidden = [row.title, row.ref, row.case_id, ...docs.results.flatMap((d) => [d.title, d.filename])];
	const send = sender(env, `${row.case_id}/${row.kind}`, n);
	if (!row.email) code = 'RECIPIENT_MISSING';
	else if (!send) code = 'EMAIL_BINDING_MISSING';
	else {
		const ctx = { kind: row.kind, origin: env.APP_ORIGIN, sender: env.SENDER, recipient: row.email, forbidden };
		const message = composeNotice({ ...ctx, noticeId });
		if (noticeProblems(message, ctx).length) code = 'NOTICE_CONTENT_REFUSED';
		else {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timedOut = new Promise<'TIMEOUT'>((resolve) => (timer = setTimeout(() => resolve('TIMEOUT'), Number(env.SEND_TIMEOUT_MS ?? 10_000))));
			try {
				const result = await Promise.race([send.send(message), timedOut]);
				if (result === 'TIMEOUT') code = 'TIMEOUT';
				else if (typeof result?.messageId === 'string' && result.messageId) messageId = result.messageId;
				else code = 'NO_MESSAGE_ID';
			} catch (e) {
				code = errorCode(e);
			} finally {
				clearTimeout(timer);
			}
		}
	}
	await record(env, noticeId, n, now, code === null ? 'accepted' : classify(code), code, messageId);
}

/**
 * The first attempt, inline, so the response can report it; bounded by SEND_TIMEOUT_MS. If it throws (a D1 error), the
 * committed publication and notice still answer 200: the row stays pending or sending, and the sweep takes it.
 */
async function firstAttempt(env: Env, noticeId: string, now: number): Promise<void> {
	await attempt(env, noticeId, now).catch(() => {});
}

/** Writes attempt n's outcome and the outbox row's next state in one batch. */
async function record(env: Env, noticeId: string, n: number, at: number, outcome: Outcome | 'accepted', code: string | null, messageId: string | null) {
	const next = outcome === 'accepted' ? null : nextAttemptAt(n, outcome, at);
	const state = outcome === 'accepted' ? 'accepted' : next === null ? 'failed' : 'retrying';
	await env.DB.batch([
		env.DB.prepare('INSERT INTO attempts (notice_id, n, at, outcome, code, message_id) VALUES (?, ?, ?, ?, ?, ?)').bind(noticeId, n, at, outcome, code, messageId),
		env.DB.prepare("UPDATE outbox SET state = ?, next_at = ?, claimed_at = NULL, updated_at = ? WHERE notice_id = ? AND state = 'sending' AND attempts = ?").bind(state, next, at, noticeId, n),
	]);
}

/** The cron sweep: settle attempts cut off mid-send as ambiguous, then try every due row once. */
async function sweep(env: Env, now: number): Promise<void> {
	const stale = await env.DB.prepare("SELECT o.notice_id, o.attempts FROM outbox o JOIN notices n ON n.id = o.notice_id WHERE n.client = ? AND o.state = 'sending' AND o.claimed_at <= ?")
		.bind(env.CLIENT_ID, now - STALE_SENDING_MS)
		.all<{ notice_id: string; attempts: number }>();
	for (const s of stale.results) await record(env, s.notice_id, s.attempts, now, 'ambiguous', 'INTERRUPTED', null);
	const due = await env.DB.prepare("SELECT o.notice_id FROM outbox o JOIN notices n ON n.id = o.notice_id WHERE n.client = ? AND o.state IN ('pending', 'retrying') AND (o.next_at IS NULL OR o.next_at <= ?) ORDER BY o.updated_at LIMIT 50")
		.bind(env.CLIENT_ID, now)
		.all<{ notice_id: string }>();
	for (const d of due.results) await attempt(env, d.notice_id, now);
}

/** Creates the in-app notice and its outbox row with `extra` in one batch, or returns the notice that already exists for this event. */
async function notify(env: Env, caseId: string, kind: NoticeKind, round: number, recipient: string, extra: Stmt[], now: number): Promise<{ noticeId: string; created: boolean }> {
	const existing = () => env.DB.prepare('SELECT id FROM notices WHERE client = ? AND case_id = ? AND kind = ? AND round = ?').bind(env.CLIENT_ID, caseId, kind, round).first<{ id: string }>();
	const before = await existing();
	if (before) return { noticeId: before.id, created: false };
	const noticeId = crypto.randomUUID();
	try {
		await env.DB.batch([
			...extra,
			env.DB.prepare('INSERT INTO notices (id, client, case_id, kind, round, recipient, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(noticeId, env.CLIENT_ID, caseId, kind, round, recipient, new Date(now).toISOString()),
			env.DB.prepare("INSERT INTO outbox (notice_id, state, attempts, next_at, claimed_at, updated_at) VALUES (?, 'pending', 0, NULL, NULL, ?)").bind(noticeId, now),
		]);
	} catch (e) {
		const raced = String(e).includes('UNIQUE constraint failed') ? await existing() : null;
		if (raced) return { noticeId: raced.id, created: false };
		throw e;
	}
	return { noticeId, created: true };
}

async function outboxView(env: Env, noticeId: string) {
	const o = await env.DB.prepare('SELECT o.state, o.attempts, o.next_at, n.kind, n.case_id, n.round, n.recipient FROM outbox o JOIN notices n ON n.id = o.notice_id WHERE o.notice_id = ? AND n.client = ?')
		.bind(noticeId, env.CLIENT_ID)
		.first<{ state: string; attempts: number; next_at: number | null; kind: string; case_id: string; round: number; recipient: string }>();
	if (!o) return null;
	const history = (await env.DB.prepare('SELECT n, at, outcome, code, message_id FROM attempts WHERE notice_id = ? ORDER BY n').bind(noticeId).all<{ n: number; at: number; outcome: string; code: string | null; message_id: string | null }>()).results;
	// attempts that may have reached the recipient: an accepted one, or one whose acceptance is unknown
	const mayHaveSent = history.filter((h) => h.outcome === 'accepted' || h.outcome === 'ambiguous').length;
	const acceptance = o.state === 'accepted' ? 'accepted' : history.some((h) => h.outcome === 'ambiguous') ? 'unknown' : history.length ? 'refused' : 'not tried';
	return {
		noticeId,
		kind: o.kind,
		caseId: o.case_id,
		round: o.round,
		recipientUser: o.recipient,
		state: o.state,
		attempts: o.attempts,
		maxAttempts: MAX_ATTEMPTS,
		nextAttemptAt: o.next_at === null ? null : new Date(o.next_at).toISOString(),
		acceptance,
		delivery: 'not observed: no provider event source locally (Queues not adopted)',
		inbox: 'not observed: inbox arrival is checked by hand at M3',
		possibleDuplicate: mayHaveSent >= 2,
		messageIds: history.flatMap((h) => (h.message_id ? [h.message_id] : [])),
		history: history.map((h) => ({ n: h.n, at: new Date(h.at).toISOString(), outcome: h.outcome, code: h.code })),
	};
}

async function caseFor(env: Env, caseId: string) {
	return env.DB.prepare('SELECT id, uploader FROM cases WHERE client = ? AND id = ?').bind(env.CLIENT_ID, caseId).first<{ id: string; uploader: string }>();
}

async function body(req: Request): Promise<Row | null> {
	try {
		const b: unknown = await req.json();
		return typeof b === 'object' && b !== null && !Array.isArray(b) ? (b as Row) : null;
	} catch {
		return null;
	}
}

async function handle(req: Request, env: Env): Promise<Response> {
	const url = new URL(req.url);
	const now = Date.now();
	if (req.method === 'GET' && url.pathname === '/health') return json({ revision: PROBE_SOURCE_REVISION, client: env.CLIENT_ID, DB: typeof env.DB?.prepare === 'function', BUCKET: typeof env.BUCKET?.put === 'function', EMAIL: typeof env.EMAIL?.send === 'function' });
	const who = await identity(req, env);
	if (!who) return refuse(401, 'sign in');

	let m = url.pathname.match(/^\/cases\/([a-z0-9-]+)\/(publish|input-needed)$/);
	if (req.method === 'POST' && m) {
		if (who.role !== 'publisher') return refuse(403, 'not a publisher');
		const c = await caseFor(env, m[1]!);
		if (!c) return refuse(404, 'no such case');
		const b = await body(req);
		const round = b?.round;
		if (!Number.isInteger(round) || (round as number) < 1) return refuse(400, 'round must be a positive integer');
		if (m[2] === 'input-needed') {
			const { noticeId, created } = await notify(env, c.id, 'input-needed', round as number, c.uploader, [], now);
			if (created) await firstAttempt(env, noticeId, now);
			return json({ inputNeeded: true, round, noticeId, created, notice: await outboxView(env, noticeId) });
		}
		const file = b?.file;
		if (typeof file !== 'string' || !file) return refuse(400, 'file must be a non-empty string');
		const key = `publications/${c.id}/${round}/results.txt`;
		const prior = await env.DB.prepare('SELECT file_sha256 FROM publications WHERE client = ? AND case_id = ? AND version = ?').bind(env.CLIENT_ID, c.id, round).first<{ file_sha256: string }>();
		if (prior && prior.file_sha256 !== (await sha256(file))) return refuse(409, `version ${round} is already published with other content`);
		if (!prior) await env.BUCKET.put(key, file);
		const digest = await sha256(file);
		const publication = env.DB.prepare('INSERT INTO publications (client, case_id, version, file_key, file_sha256, published_at) VALUES (?, ?, ?, ?, ?, ?)').bind(env.CLIENT_ID, c.id, round, key, digest, new Date(now).toISOString());
		const { noticeId, created } = await notify(env, c.id, 'publication', round as number, c.uploader, prior ? [] : [publication], now);
		// The publication is committed above; the email below can only add to the outbox row.
		if (created) await firstAttempt(env, noticeId, now);
		return json({ published: true, version: round, fileSha256: digest, noticeId, created, notice: await outboxView(env, noticeId) });
	}

	m = url.pathname.match(/^\/n\/([0-9a-f-]{36})$/);
	if (req.method === 'GET' && m) {
		const n = await env.DB.prepare('SELECT case_id, recipient FROM notices WHERE client = ? AND id = ?').bind(env.CLIENT_ID, m[1]).first<{ case_id: string; recipient: string }>();
		if (!n || n.recipient !== who.id) return refuse(404, 'no such notice');
		return new Response(null, { status: 303, headers: { location: `/cases/${n.case_id}` } });
	}

	m = url.pathname.match(/^\/cases\/([a-z0-9-]+)(\/file)?$/);
	if (req.method === 'GET' && m) {
		const c = await caseFor(env, m[1]!);
		if (!c || (c.uploader !== who.id && who.role !== 'publisher')) return refuse(404, 'no such case');
		if (m[2]) {
			const p = await env.DB.prepare('SELECT file_key FROM publications WHERE client = ? AND case_id = ? AND version = ?').bind(env.CLIENT_ID, c.id, Number(url.searchParams.get('version'))).first<{ file_key: string }>();
			const object = p ? await env.BUCKET.get(p.file_key) : null;
			return object ? new Response(await object.text(), { headers: { 'content-type': 'text/plain; charset=utf-8' } }) : refuse(404, 'no such file');
		}
		const publications = (await env.DB.prepare('SELECT version, file_sha256, published_at FROM publications WHERE client = ? AND case_id = ? ORDER BY version').bind(env.CLIENT_ID, c.id).all()).results;
		const notices = (await env.DB.prepare('SELECT id, kind, round, created_at FROM notices WHERE client = ? AND case_id = ? AND recipient = ? ORDER BY created_at, id').bind(env.CLIENT_ID, c.id, c.uploader).all()).results;
		return json({ caseId: c.id, publications, notices });
	}

	if (req.method === 'GET' && url.pathname === '/ops/notifications') {
		if (who.role !== 'operator') return refuse(403, 'not an operator');
		const ids = (await env.DB.prepare('SELECT o.notice_id FROM outbox o JOIN notices n ON n.id = o.notice_id WHERE n.client = ? ORDER BY n.created_at, n.id').bind(env.CLIENT_ID).all<{ notice_id: string }>()).results;
		return json({ notifications: await Promise.all(ids.map((r) => outboxView(env, r.notice_id))) });
	}
	return refuse(404, 'not found');
}

export default {
	fetch: (req: Request, env: Env) => handle(req, env),
	// awaited, not waitUntil: the trigger's answer then means the sweep has finished
	scheduled: (controller: { scheduledTime: number }, env: Env) => sweep(env, controller.scheduledTime),
};
