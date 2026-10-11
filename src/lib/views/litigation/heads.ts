// Heads of Argument (heads_tab): the user's submissions (register store `heads`, by `seq`), their evidence refs and the
// plain-text skeleton export. Browser-safe.

export const HEADS_FIELDS = ['head', 'sub', 'auth', 'ref'] as const;
export type HeadsValues = Record<(typeof HEADS_FIELDS)[number], string>;

/** v5 addHead: a submission needs a heading or a submission text; otherwise nothing is added. */
export const canAddHead = (v: HeadsValues) => !!(v.sub || v.head);

/** v5 drawHeads: evidence refs split on spaces and commas only (S-heads_tab-2, copied: a semicolon is not a separator). */
export const splitRefs = (ref: string) => (ref || '').split(/[ ,]+/).filter(Boolean);

/**
 * Each token of an evidence field with whether it names a document row of the version (the document-row contract,
 * rescan rows included, as v5's allRows()). Exact match only, never fuzzy: any other token stays plain text.
 */
export const evidenceTokens = (ref: string, isDocument: (ref: string) => boolean) => splitRefs(ref).map((t) => ({ text: t, ref: isDocument(t) }));

/** The skeleton's first line: the literal heading and the case caption from view-content, when the package has it. */
export const headsTitle = (caption: string | null) => (caption ? `HEADS OF ARGUMENT — ${caption}` : 'HEADS OF ARGUMENT');

/**
 * A user field as one line of the export (GRS-18 r2, D19; normalised when exporting, the stored text stays as typed):
 * each run of line and paragraph separators (CR, LF, NEL, LS, PS, VT, FF) becomes one space, and the other C0 controls
 * and DEL are dropped, so a field can never start a forged numbered line.
 */
export const exportLine = (v: string) => (v || '').replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ').replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g, '');

/** v5 exportHeads: the title, a blank line, then each submission numbered with its authority and evidence. */
export function headsText(rows: readonly HeadsValues[], caption: string | null): string {
	let out = `${headsTitle(caption)}\n\n`;
	const f = exportLine;
	rows.forEach((x, i) => { out += `${i + 1}. ${f(x.head)}\n   ${f(x.sub)}\n   Authority: ${f(x.auth)}\n   Evidence: ${f(x.ref)}\n\n`; });
	return out;
}

/** The export's file name: generic (v5's name carried the case's abbreviations; S-hardcoded-case). */
export const HEADS_FILE = 'heads_of_argument.txt';
