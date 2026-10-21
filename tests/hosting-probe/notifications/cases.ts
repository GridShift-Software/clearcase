// The notification probe's own test command (GRS-111). From this directory:
//
//   bun run --bun test
//
// Adverse notices against the content check the Worker runs before every send and the runner runs on every saved
// message: each must be refused, and the one clean notice accepted. Exit 1 on any case that goes the wrong way.
import { composeNotice, noticeProblems, type Message } from './src/notice.ts';

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
expect('the input-needed body under a publication notice', composeNotice({ ...ctx, kind: 'input-needed', noticeId: NOTICE_ID }) satisfies Message, true);

console.log(failures.join('\n'));
console.log(failures.length ? `CASES FAIL: ${failures.length} went the wrong way` : 'CASES PASS');
process.exit(failures.length ? 1 : 0);
