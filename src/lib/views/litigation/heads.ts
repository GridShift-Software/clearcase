
export const HEADS_FIELDS = ['head', 'sub', 'auth', 'ref'] as const;
export type HeadsValues = Record<(typeof HEADS_FIELDS)[number], string>;

export const canAddHead = (v: HeadsValues) => !!(v.sub || v.head);

export const splitRefs = (ref: string) => (ref || '').split(/[ ,]+/).filter(Boolean);

export const evidenceTokens = (ref: string, isDocument: (ref: string) => boolean) => splitRefs(ref).map((t) => ({ text: t, ref: isDocument(t) }));

export const headsTitle = (caption: string | null) => (caption ? `HEADS OF ARGUMENT — ${caption}` : 'HEADS OF ARGUMENT');

export const exportLine = (v: string) => (v || '').replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ').replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g, '');

export function headsText(rows: readonly HeadsValues[], caption: string | null): string {
	let out = `${headsTitle(caption)}\n\n`;
	const f = exportLine;
	rows.forEach((x, i) => { out += `${i + 1}. ${f(x.head)}\n   ${f(x.sub)}\n   Authority: ${f(x.auth)}\n   Evidence: ${f(x.ref)}\n\n`; });
	return out;
}

export const HEADS_FILE = 'heads_of_argument.txt';
