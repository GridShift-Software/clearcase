// Value normalization for parity comparison. Every rule is explicit and tested (tests/parity/normalize.test.ts);
// anything a rule does not cover is compared exactly. Normalization removes presentation noise only (white space,
// digit grouping, equivalent date spellings, the order of ties a view does not define). It never maps one visible
// wording onto another: a changed word is a difference, and an intended one belongs on the register.

/** White space: NFC, every Unicode space (NBSP, thin, narrow NBSP) as a plain space, runs collapsed, trimmed. */
export const ws = (s) => (s === null || s === undefined ? '' : String(s)).normalize('NFC').replace(/[\s  -​  　]+/g, ' ').trim();

const GROUPED = /^([-+]?)(\d{1,3}(?:[ ,]\d{3})+|\d+)(\.\d+)?$/;
const MONEY = /^([-+]?)R ?([-+]?)(\d{1,3}(?:[ ,]\d{3})+|\d+)(\.\d+)?$/;

/**
 * A number shown with digit grouping ('1,689', '1 689', '1689') becomes its plain digits; money in the v5 fmtR shape
 * ('R 1 234.50', '-R 5.00', 'R1,234.50') becomes 'R<digits>.<decimals>' with the sign in front. Decimals are kept as
 * shown ('2.50' stays '2.50'): a change in shown precision is a difference. Anything else is returned unchanged.
 */
export function number(s) {
	const t = ws(s);
	let m = MONEY.exec(t);
	if (m) return `${m[1] === '-' || m[2] === '-' ? '-' : ''}R${m[3].replace(/[ ,]/g, '')}${m[4] ?? ''}`.replace(/^-R0(\.0+)?$/, 'R0$1');
	m = GROUPED.exec(t);
	if (m) return `${m[1] === '-' ? '-' : ''}${m[2].replace(/[ ,]/g, '')}${m[3] ?? ''}`;
	return t;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/**
 * Dates: ISO 'YYYY-MM-DD' (optionally with ' HH:MM' or 'THH:MM[:SS][Z]') is kept as is; 'D Mon YYYY' and
 * 'D Month YYYY' become ISO. Ambiguous numeric forms (01/02/2026) are not guessed and stay unchanged.
 */
export function date(s) {
	const t = ws(s);
	const m = /^(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})$/.exec(t);
	if (m) {
		const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
		if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
	}
	return t;
}

/** A shown value: white space, then number and money grouping, then date spelling. */
export const value = (s) => date(number(ws(s)));

/**
 * Sort stability: within each run of equal sort values, order keys by code unit. Use only where the view does not
 * define the order of ties; where it does (v5 sorts are stable and the pilot keeps source order), compare as is.
 */
export function canonicalTies(keys, sortValues) {
	const out = [];
	for (let i = 0; i < keys.length;) {
		let j = i;
		while (j < keys.length && sortValues[j] === sortValues[i]) j++;
		out.push(...keys.slice(i, j).sort());
		i = j;
	}
	return out;
}

/**
 * A control's identity in the action inventory: kind plus label, white space collapsed, sort indicators removed and
 * every run of digits (with grouping) replaced by '#', so 'Export CSV (1,689 rows)' is 'button:Export CSV (# rows)'.
 * Labels that differ only in a count are the same control; the count itself is compared elsewhere.
 */
export const controlId = (kind, label) => `${kind}:${ws(label).replace(/\s*[▲▼↑↓]\s*$/u, '').replace(/\d{1,3}(?:[ ,]\d{3})+|\d+/g, '#')}`;

/** Collapse a control list into inventory ids with multiplicity. */
export function inventory(controls) {
	const inv = {};
	for (const c of controls) { const id = controlId(c.kind, c.label); inv[id] = (inv[id] ?? 0) + 1; }
	return inv;
}

/** A stable identifier from a label: lower case, non-alphanumerics as '_' (used for v5 field ids). */
export const slug = (s) => ws(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || '_';
