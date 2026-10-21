// The notification probe's own test command (GRS-111). From this directory:
//
//   bun run --bun test
//
// 1. Adverse notices against the content check the Worker runs before every send and the runner runs on every saved
//    message: each must be refused, and the one clean notice accepted.
// 2. The retry policy: every documented send() error code, the simulator's restrictions and the app's own codes map to
//    the outcome the policy names, and the schedule is bounded.
// 3. The committed evidence summary, its SHAs pointed at HEAD, passes `--check`'s shape, and every mutation of it
//    (summary.ts's walk: each leaf and container deleted, nulled, retyped, emptied, flipped or zeroed, and an unknown
//    key added to each object) is refused.
// Exit 1 on any case that goes the wrong way.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { composeNotice, noticeProblems, type Message } from './src/notice.ts';
import { classify, DOCUMENTED_CODES, errorCode, MAX_ATTEMPTS, nextAttemptAt } from './src/policy.ts';
import { checkSummary, mutationsRefused } from './summary.ts';

const NOTICE_ID = '7d3f0b6e-2c4a-4e8b-9f10-3a5b6c7d8e9f';
const ctx = {
	kind: 'publication' as const,
	origin: 'https://client-a.example.test',
	sender: 'notices@notify.client-a.example.test',
	recipient: 'uploader-a@client-a.example.test',
	// what the case holds that a notice must never carry: its title, a document title, a file name, its reference
	forbidden: ['Synthetic Matter A1', 'Synthetic Expert Report', 'a1-report.pdf', 'SYN-A1-0001'],
};
const clean = composeNotice({ ...ctx, noticeId: NOTICE_ID });

const failures: string[] = [];
function expect(label: string, message: unknown, refused: boolean) {
	const problems = noticeProblems(message, ctx);
	if (refused !== problems.length > 0) failures.push(`${label}: ${refused ? 'accepted' : `refused (${problems.join('; ')})`}`);
	else console.log(`ok      ${label}${problems.length ? `: ${problems[0]}` : ''}`);
}
const edit = (change: (m: Record<string, unknown>) => void) => {
	const m: Record<string, unknown> = structuredClone(clean);
	change(m);
	return m;
};

expect('the clean publication notice', clean, false);
expect('a body that carries a document title', edit((m) => (m.text = `${m.text}\nDocument: Synthetic Expert Report`)), true);
expect('a body that carries the case title', edit((m) => (m.text = String(m.text).replace('ClearCase', 'ClearCase: Synthetic Matter A1'))), true);
expect('a subject that carries the case reference', edit((m) => (m.subject = `${m.subject} (SYN-A1-0001)`)), true);
expect('an attachment', edit((m) => (m.attachments = [{ filename: 'a1-report.pdf', type: 'application/pdf', content: 'x' }])), true);
expect('an HTML part', edit((m) => (m.html = '<p>ClearCase</p>')), true);
expect('a link that carries a bearer token', edit((m) => (m.text = String(m.text).replace(NOTICE_ID, `${NOTICE_ID}?token=abc`))), true);
expect("a link to another client's origin", edit((m) => (m.text = String(m.text).replace(ctx.origin, 'https://client-b.example.test'))), true);
expect('a recipient other than the uploader', edit((m) => (m.to = 'someone@client-b.example.test')), true);
expect('a second recipient', edit((m) => (m.to = [ctx.recipient, 'someone@client-a.example.test'])), true);
expect('a sender other than the client sender', edit((m) => (m.from = 'notices@notify.client-b.example.test')), true);
for (const field of ['from', 'to', 'subject', 'text']) {
	expect(`${field} missing`, edit((m) => delete m[field]), true);
	expect(`${field} null`, edit((m) => (m[field] = null)), true);
	expect(`${field} retyped`, edit((m) => (m[field] = 1)), true);
}
expect('not an object', 'ClearCase', true);

// The recipient is data (users.email) and the origin and sender are configuration: the Worker builds the message from
// them, so a check that compares the message with those same inputs accepts whatever they hold. `viaWorker` is how the
// Worker calls the check: the message is composed from the values given, the check is told the client.
const viaWorker = (label: string, given: Partial<typeof ctx>) => {
	const c = { ...ctx, clientId: 'client-a', ...given };
	const problems = noticeProblems(composeNotice({ ...c, noticeId: NOTICE_ID }), c);
	if (problems.length === 0) failures.push(`${label}: accepted`);
	else console.log(`ok      ${label}: ${problems[0]}`);
};
viaWorker('a data-borne recipient with a comma', { recipient: 'uploader-a@client-a.example.test, viewer-a@client-a.example.test' });
viaWorker('a data-borne recipient with a CRLF Bcc: header', { recipient: 'uploader-a@client-a.example.test\r\nBcc: operator-a@client-a.example.test' });
viaWorker('a data-borne recipient with a bare LF header', { recipient: 'uploader-a@client-a.example.test\nBcc: operator-a@client-a.example.test' });
viaWorker('a data-borne recipient with a display name', { recipient: 'A. Uploader <uploader-a@client-a.example.test>' });
viaWorker('a data-borne recipient with a quoted display name', { recipient: '"Uploader, A" <uploader-a@client-a.example.test>' });
viaWorker('a data-borne recipient that is not an address', { recipient: 'uploader-a' });
viaWorker("client B's origin on client A's Worker", { origin: 'https://client-b.example.test' });
viaWorker("client B's sender on client A's Worker", { sender: 'notices@notify.client-b.example.test' });
viaWorker("client B's origin and sender on client A's Worker", { origin: 'https://client-b.example.test', sender: 'notices@notify.client-b.example.test' });
expect('the input-needed body under a publication notice', composeNotice({ ...ctx, kind: 'input-needed', noticeId: NOTICE_ID }) satisfies Message, true);

// 2. The retry policy
const policy = (label: string, ok: boolean) => (ok ? console.log(`ok      ${label}`) : failures.push(label));
const coded = (code: unknown) => Object.assign(new Error('provider failure for uploader-a@client-a.example.test'), { code });
const permanent = DOCUMENTED_CODES.filter((c) => !['E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED', 'E_DELIVERY_FAILED', 'E_INTERNAL_SERVER_ERROR'].includes(c));
policy('the 20 documented send() codes are all classified', DOCUMENTED_CODES.length === 20 && new Set(DOCUMENTED_CODES).size === 20);
policy('16 documented codes are permanent (the message itself was refused)', permanent.length === 16 && permanent.every((c) => classify(c) === 'permanent'));
policy('rate and daily limits are transient', classify('E_RATE_LIMIT_EXCEEDED') === 'transient' && classify('E_DAILY_LIMIT_EXCEEDED') === 'transient');
policy('internal error, delivery failure, timeout, interruption, a missing messageId and an unknown code are ambiguous', ['E_INTERNAL_SERVER_ERROR', 'E_DELIVERY_FAILED', 'TIMEOUT', 'INTERRUPTED', 'NO_MESSAGE_ID', 'UNKNOWN', 'E_NOT_YET_DOCUMENTED'].every((c) => classify(c) === 'ambiguous'));
policy("the app's own refusals are permanent", ['NOTICE_CONTENT_REFUSED', 'EMAIL_BINDING_MISSING', 'RECIPIENT_MISSING'].every((c) => classify(c) === 'permanent'));
policy('a thrown error is recorded by its code', errorCode(coded('E_RECIPIENT_SUPPRESSED')) === 'E_RECIPIENT_SUPPRESSED');
policy("the simulator's two restrictions are recognised and permanent", errorCode(new Error('email from notices@notify.client-b.example.test not allowed')) === 'LOCAL_SENDER_NOT_ALLOWED' && errorCode(new Error('email to x@client-b.example.test not allowed')) === 'LOCAL_RECIPIENT_NOT_ALLOWED' && classify('LOCAL_SENDER_NOT_ALLOWED') === 'permanent' && classify('LOCAL_RECIPIENT_NOT_ALLOWED') === 'permanent');
policy('an error with no code, a retyped code or a lower-case code is UNKNOWN (ambiguous), never its message', [new Error('uploader-a@client-a.example.test'), coded(7), coded('e_rate_limit_exceeded'), coded(null), null, 'E_RATE_LIMIT_EXCEEDED'].every((e) => errorCode(e) === 'UNKNOWN'));
policy('attempt 2 is due 5 min after attempt 1, attempt 3 30 min after attempt 2', nextAttemptAt(1, 'transient', 0) === 300_000 && nextAttemptAt(2, 'ambiguous', 1_000) === 1_801_000);
policy(`no attempt follows attempt ${MAX_ATTEMPTS} or a permanent failure`, MAX_ATTEMPTS === 3 && nextAttemptAt(3, 'ambiguous', 0) === null && nextAttemptAt(1, 'permanent', 0) === null && nextAttemptAt(4, 'transient', 0) === null);

// 3. The committed evidence and the summary check
const failuresBeforeEvidence = failures.length;
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8' }).stdout.trim();
// NOTIFICATIONS_EVIDENCE names another file to check; tamper.ts uses it to prove that stale evidence fails this command.
const evidence = JSON.parse(readFileSync(process.env.NOTIFICATIONS_EVIDENCE ?? path.join(import.meta.dirname, '../../../docs/acceptance/hosting/evidence/notifications-summary.json'), 'utf8')) as Record<string, unknown>;
const control = { ...structuredClone(evidence), sourceSha: head, servedRevision: head };
const controlProblems = checkSummary(control, head);
policy(`the committed evidence passes the summary check at HEAD${controlProblems.length ? ` (${controlProblems[0]})` : ''}`, controlProblems.length === 0);
const walk = mutationsRefused(control, head);
policy(`every mutation of the committed evidence is refused (${walk.refused} refused${walk.accepted ? `; accepted: ${walk.accepted}` : ''})`, walk.accepted === null && walk.refused > 500);
policy('a summary for another SHA is refused', checkSummary(evidence, '1'.repeat(40)).length > 0);
console.log(failures.length > failuresBeforeEvidence ? 'EVIDENCE FAIL' : 'EVIDENCE PASS');

console.log(failures.join('\n'));
console.log(failures.length ? `CASES FAIL: ${failures.length} went the wrong way` : 'CASES PASS');
process.exit(failures.length ? 1 : 0);
