// The minimal transactional notice (GRS-111): one fixed subject and body per kind, and the only variable part is an
// authenticated app link. The Worker runs noticeProblems before every send and refuses the send on any problem; the
// probe runner runs it again on every message the simulated binding saved.
//
// The check is an allowlist, not a scan for bad words: the message has exactly the keys from, to, subject and text,
// each a string; from is the client's sender, to is the uploader alone; subject and text equal the kind's template
// around one link of the form <origin>/n/<uuid> (no query, fragment, token or other path). A denylist of what the case
// holds (titles, file names, references) runs on top, so a template edited to carry case text still fails.

export type NoticeKind = 'publication' | 'input-needed';
export type Message = { from: string; to: string; subject: string; text: string };
export type NoticeContext = { kind: NoticeKind; origin: string; sender: string; recipient: string; forbidden: string[] };

/** Provisional ClearCase branding (GRS-93, 16 October 2026): generic subjects, no case or client wording. */
const TEMPLATES: Record<NoticeKind, { subject: string; body: (link: string) => string }> = {
	publication: {
		subject: 'ClearCase: new results are ready',
		body: (link) => `New results are ready in ClearCase.\n\nSign in to view them:\n${link}\n\nThis message has no case details. If you did not expect it, ignore it.\n`,
	},
	'input-needed': {
		subject: 'ClearCase: information is needed',
		body: (link) => `ClearCase needs more information to continue.\n\nSign in to see what is needed:\n${link}\n\nThis message has no case details. If you did not expect it, ignore it.\n`,
	},
};
export const NOTICE_KINDS = Object.keys(TEMPLATES) as NoticeKind[];
const KEYS = ['from', 'subject', 'text', 'to'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const noticeLink = (origin: string, noticeId: string) => `${origin}/n/${noticeId}`;

export function composeNotice(n: { kind: NoticeKind; origin: string; sender: string; recipient: string; noticeId: string }): Message {
	const t = TEMPLATES[n.kind];
	return { from: n.sender, to: n.recipient, subject: t.subject, text: t.body(noticeLink(n.origin, n.noticeId)) };
}

/** The notice id the message links to, or null when its link is not exactly `<origin>/n/<uuid>`. */
export function linkedNotice(text: string, origin: string): string | null {
	const links = text.match(/https?:\/\/\S+/g) ?? [];
	if (links.length !== 1) return null;
	const prefix = `${origin}/n/`;
	const id = links[0]!.startsWith(prefix) ? links[0]!.slice(prefix.length) : '';
	return UUID.test(id) ? id : null;
}

/** Every reason `message` is not the minimal notice of `ctx.kind` for this client and uploader; empty means it is. */
export function noticeProblems(message: unknown, ctx: NoticeContext): string[] {
	if (typeof message !== 'object' || message === null || Array.isArray(message)) return ['the message is not an object'];
	const m = message as Record<string, unknown>;
	const problems: string[] = [];
	const keys = Object.keys(m).sort();
	if (keys.join() !== KEYS.join()) problems.push(`the message has keys [${keys.join(', ')}], not exactly [${KEYS.join(', ')}] (no html, attachments, cc, bcc, replyTo or headers)`);
	for (const k of KEYS) if (typeof m[k] !== 'string' || m[k] === '') problems.push(`${k} is ${m[k] === undefined ? 'missing' : JSON.stringify(m[k])}, not a non-empty string`);
	if (problems.length) return problems;
	const { from, to, subject, text } = m as Message;
	if (from !== ctx.sender) problems.push("from is not this client's sender");
	if (to !== ctx.recipient) problems.push('to is not the uploader alone');
	const t = TEMPLATES[ctx.kind];
	if (subject !== t.subject) problems.push(`subject is not the ${ctx.kind} subject`);
	const id = linkedNotice(text, ctx.origin);
	if (id === null) problems.push(`the body does not carry exactly one link of the form ${ctx.origin}/n/<uuid>`);
	else if (text !== t.body(noticeLink(ctx.origin, id))) problems.push(`the body is not the ${ctx.kind} template around its link`);
	const all = `${from}\n${to}\n${subject}\n${text}`.toLowerCase();
	for (const f of ctx.forbidden) if (f && all.includes(f.toLowerCase())) problems.push('the message carries case content (a forbidden fixture string)');
	return problems;
}
