/**
 * Text for the PDFs the builder draws: Helvetica-Bold widths and WinAnsi encoding (v5 PDFK 1357-1380).
 *
 * v5's `ascii()` dropped every character outside printable ASCII, so an accented name lost its letters in the PDF
 * index (S-court_bundle_tab-6). Here every character the WinAnsi font has is kept, a letter it lacks falls back to
 * its unaccented base letter, and anything else becomes '?'. Curly quotes and dashes are kept as themselves.
 */

const HELV_B = (
	'278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 ' +
	'584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 ' +
	'667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 ' +
	'333 611 556 778 556 556 500 389 280 389 584'
)
	.split(' ')
	.map(Number);

/** WinAnsiEncoding bytes 0x80-0x9F that differ from Latin-1. */
const WIN_HIGH: Record<string, number> = {
	'€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a,
	'‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
	'˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};
/** Helvetica-Bold widths of the punctuation outside ASCII that indexes use; other letters take their base letter's. */
const WIDE: Record<string, number> = {
	'‘': 278, '’': 278, '‚': 278, '“': 500, '”': 500, '„': 500, '–': 556, '—': 1000, '…': 1000, '•': 350, '€': 556,
	'«': 556, '»': 556, '°': 400, '§': 556, '©': 737, '®': 737, '™': 1000, '·': 278, '×': 584, '½': 834, '¼': 834,
	'¾': 834, 'Æ': 1000, 'æ': 889, 'Œ': 1000, 'œ': 944, 'ß': 611, 'ø': 611, 'Ø': 778,
};

/** Letters whose base letter Unicode does not decompose to. */
const FOLD: Record<string, string> = { 'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', 'Ħ': 'H', 'ħ': 'h', 'ı': 'i', 'Ŀ': 'L', 'ŀ': 'l', 'Ŧ': 'T', 'ŧ': 't' };

const encodable = (c: string) => {
	const k = c.charCodeAt(0);
	return (k >= 0x20 && k <= 0x7e) || (k >= 0xa1 && k <= 0xff) || c in WIN_HIGH;
};

/** One line of index text as the WinAnsi font can show it (still Unicode; `winAnsi` encodes it). */
export function clean(s: unknown): string {
	let out = '';
	for (const ch of String(s ?? '')
		.normalize('NFC')
		.replace(/[  -   　\t]/g, ' ')) {
		if (encodable(ch)) out += ch;
		else if (ch === '\n') out += ch;
		else {
			const base = FOLD[ch] ?? ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
			out += base && [...base].every(encodable) ? base : /[\u0000-\u001f\u007f-\u009f​-‍⁠﻿]/.test(ch) ? '' : '?';
		}
	}
	return out;
}

function charWidth(ch: string): number {
	const k = ch.charCodeAt(0);
	if (k >= 32 && k <= 126) return HELV_B[k - 32];
	if (ch in WIDE) return WIDE[ch];
	const base = (FOLD[ch] ?? ch.normalize('NFD')).charCodeAt(0);
	return base >= 32 && base <= 126 ? HELV_B[base - 32] : 556;
}

/** Width in points of cleaned text in Helvetica-Bold at `size`. */
export function textWidth(s: string, size: number): number {
	let w = 0;
	for (const ch of s) w += charWidth(ch);
	return (w * size) / 1000;
}

/** Cleaned text as a WinAnsi byte string, escaped for a literal string in a content stream. */
export function pdfText(s: string): string {
	let out = '';
	for (const ch of s) {
		const k = ch.charCodeAt(0);
		const b = ch in WIN_HIGH ? WIN_HIGH[ch] : k < 256 ? k : 0x3f;
		if (b === 0x5c || b === 0x28 || b === 0x29) out += '\\' + String.fromCharCode(b);
		else if (b === 0x0a || b === 0x0d) out += ' ';
		else out += String.fromCharCode(b);
	}
	return out;
}
