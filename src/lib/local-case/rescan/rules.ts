// Rescan & Update rules (GRS-20), pure: how a walked case folder compares with the active results version, and how a
// new file is described. v5 (rescan_tab, L2793-2826) is the reference; where it was wrong the rule says so:
//  * S-rescan_tab-1: files are matched by their decoded path relative to the case folder, the same key the import
//    used, so an indexed original is never re-added as new.
//  * S-rescan_tab-2: changes are detected. A quick scan compares sizes (and, for files a rescan added, sizes and
//    modification times); a full scan also compares SHA-256 with the verified original, so a same-name, same-size
//    change is found. A quick scan never claims the folder matches the analysis.
//  * S-rescan_tab-4: a new ref continues the highest number already used with its prefix (imported refs, rescan refs
//    and refs a cleared rescan issued), zero-padded to the width the case uses, so it never collides or misorders.
//  * S-rescan_tab-7: every new file is pending processing; nothing claims extracted text that was never extracted.
// Dates parsed from a file name must be real calendar dates (v5 accepted 2001-13-40).

import { isPathKey } from '../../case-package/refs.ts';

export type ScanMode = 'quick' | 'full';
/** A file found in the case folder: its path relative to the folder ('/'-separated), size and modification time. */
export interface WalkedFile { path: string; size: number; mtimeMs: number; sha256?: string | null }
/** An original the active version indexed (an asset of kind file that the import found on disk). */
export interface IndexedOriginal { ref: string; path: string; size: number | null; sha256: string | null; bundle: string }
/** One rescan row as stored: a difference from the results, keyed by path. */
export interface RescanFile {
	path: string;
	/** added: a file the results do not index; withdrawn: an addition no longer in the folder (its ref stays issued);
	 *  changed: an indexed original whose content differs; removed: an indexed original no longer in the folder */
	kind: 'added' | 'withdrawn' | 'changed' | 'removed';
	ref: string;
	size: number | null;
	mtimeMs: number | null;
	sha256: string | null;
	bundle: string;
	date: string;
	docType: string;
	/** how the change was found: 'size', 'sha256' (full scan) or '' */
	evidence: string;
	/** processing state of an addition: 'pending' until a new results version indexes it; never reset by a rescan */
	processing: string;
}
export interface ScanOutcome {
	rows: RescanFile[];
	/** highest number issued per ref prefix, after this scan */
	issued: Record<string, number>;
	counts: { scanned: number; indexed: number; added: number; newlyAdded: number; changed: number; removed: number; unchangedBySize: number };
}

/** v5 bundleOf (L2801): the top-level folder upper-cased; ORIGINAL, SUPPLEMENT(A)RY, CORRESPOND, PLEADING. */
export function bundleOfFolder(top: string): string {
	const u = top.toUpperCase();
	if (u.includes('ORIGINAL')) return 'Original';
	if (u.includes('SUPPLEMENTRY') || u.includes('SUPPLEMENTARY')) return 'Supplementary';
	if (u.includes('CORRESPOND')) return 'Correspondence';
	if (u.includes('PLEADING')) return 'Pleadings';
	return 'Original';
}
/** v5 refCode (L193): Original OD, Supplementary SD, Correspondence EM, Pleadings PN, anything else XX. */
export function refPrefix(bundle: string): string {
	return ({ Original: 'OD', Supplementary: 'SD', Correspondence: 'EM', Pleadings: 'PN' } as Record<string, string>)[bundle] ?? 'XX';
}

const real = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');
/** v5 date rule (L2807-2808): the first 20YY-M-D, else D-M-20YY, with '.', '_' or '-' between; '' when none (or not a
 *  real date). */
export function dateFromName(name: string): string {
	const a = /(20\d\d)[._-](\d{1,2})[._-](\d{1,2})/.exec(name);
	if (a && real(+a[1], +a[2], +a[3])) return `${a[1]}-${pad(+a[2])}-${pad(+a[3])}`;
	const b = /(\d{1,2})[._-](\d{1,2})[._-](20\d\d)/.exec(name);
	if (b && real(+b[3], +b[2], +b[1])) return `${b[3]}-${pad(+b[2])}-${pad(+b[1])}`;
	return '';
}
/** v5 doc_type (L2810): eml/msg are email; a file name naming an invoice is an invoice (v5 used a case-specific
 *  pattern); everything else other. */
export function docTypeOf(name: string): string {
	const ext = name.toLowerCase().split('.').pop() ?? '';
	if (ext === 'eml' || ext === 'msg') return 'email';
	return /invoice/i.test(name) ? 'invoice' : 'other';
}

const REF = /^([A-Za-z]+)-(\d+)$/;
/** A document ref's prefix and number; null for anything else, and for a package file's key (P- plus 16 hex digits,
 *  which can be all digits): that names a linked file, never a document, so it must not set a prefix or a number. */
const docRef = (ref: string) => (isPathKey(ref) ? null : REF.exec(ref));
const top = (p: string) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '');

/** Where a new file's ref and bundle come from: the indexed originals of the same top-level folder (their most
 *  common prefix and bundle), else v5's bundleOf on the folder (a file at the root: on its own name) and refCode. */
export function folderRules(indexed: readonly IndexedOriginal[]): (path: string) => { prefix: string; bundle: string } {
	const by = new Map<string, Map<string, { n: number; bundle: string }>>();
	for (const o of indexed) {
		const m = docRef(o.ref);
		if (!m) continue;
		const t = top(o.path);
		const tally = by.get(t) ?? new Map();
		const e = tally.get(m[1]) ?? { n: 0, bundle: o.bundle };
		e.n++;
		tally.set(m[1], e);
		by.set(t, tally);
	}
	return (p) => {
		const t = top(p);
		const tally = by.get(t);
		if (tally && tally.size) {
			const [prefix, e] = [...tally].sort((x, y) => y[1].n - x[1].n || (x[0] < y[0] ? -1 : 1))[0];
			return { prefix, bundle: e.bundle };
		}
		const bundle = bundleOfFolder(t || p);
		return { prefix: refPrefix(bundle), bundle };
	};
}

/** Highest number and widest width used per prefix by a set of refs. */
export function refUse(refs: Iterable<string>): Map<string, { max: number; width: number }> {
	const out = new Map<string, { max: number; width: number }>();
	for (const r of refs) {
		const m = docRef(r);
		if (!m) continue;
		const e = out.get(m[1]) ?? { max: 0, width: 0 };
		e.max = Math.max(e.max, Number(m[2]));
		e.width = Math.max(e.width, m[2].length);
		out.set(m[1], e);
	}
	return out;
}

const norm = (p: string) => p.normalize('NFC');

/**
 * Compare a walk with the indexed originals and the previous rescan rows. Deterministic: new files are numbered in
 * path order. A repeat scan of an unchanged folder returns the previous rows unchanged (same refs, same order).
 * `takenRefs` is every ref of the version (documents and attachments), so a new ref never names one of them.
 */
export function compare(input: {
	mode: ScanMode;
	walked: readonly WalkedFile[];
	indexed: readonly IndexedOriginal[];
	previous: readonly RescanFile[];
	issued: Readonly<Record<string, number>>;
	takenRefs: ReadonlySet<string>;
}): ScanOutcome {
	const { mode, walked, indexed, previous } = input;
	const indexedBy = new Map(indexed.map((o) => [norm(o.path), o]));
	const prevBy = new Map(previous.map((r) => [norm(r.path), r]));
	const walkedBy = new Map(walked.map((f) => [norm(f.path), f]));
	const rules = folderRules(indexed);
	const use = refUse([...input.takenRefs, ...previous.map((r) => r.ref)]);
	const issued: Record<string, number> = { ...input.issued };
	for (const [p, u] of use) issued[p] = Math.max(issued[p] ?? 0, u.max);
	const rows: RescanFile[] = [];
	const counts = { scanned: walked.length, indexed: 0, added: 0, newlyAdded: 0, changed: 0, removed: 0, unchangedBySize: 0 };

	for (const o of indexed) {
		const f = walkedBy.get(norm(o.path));
		const prev = prevBy.get(norm(o.path));
		if (!f) {
			rows.push({ path: o.path, kind: 'removed', ref: o.ref, size: o.size, mtimeMs: null, sha256: o.sha256, bundle: o.bundle, date: '', docType: '', evidence: '', processing: '' });
			counts.removed++;
			continue;
		}
		counts.indexed++;
		let evidence = '';
		if (o.size !== null && f.size !== o.size) evidence = 'size';
		else if (mode === 'full' && f.sha256 && o.sha256 && f.sha256 !== o.sha256) evidence = 'sha256';
		// a quick scan cannot see a same-size change: a change an earlier full scan found stays reported
		else if (mode === 'quick' && prev?.kind === 'changed' && prev.evidence === 'sha256') evidence = 'sha256';
		if (evidence) {
			rows.push({ path: o.path, kind: 'changed', ref: o.ref, size: f.size, mtimeMs: f.mtimeMs, sha256: f.sha256 ?? (evidence === 'sha256' ? prev?.sha256 ?? null : null), bundle: o.bundle, date: '', docType: '', evidence, processing: '' });
			counts.changed++;
		} else if (mode === 'quick') counts.unchangedBySize++;
	}

	const fresh: WalkedFile[] = [];
	for (const f of walked) {
		if (indexedBy.has(norm(f.path))) continue;
		const prev = prevBy.get(norm(f.path));
		if (prev && (prev.kind === 'added' || prev.kind === 'withdrawn')) {
			// the same path keeps its ref; a changed size or time updates what is recorded, and a quick scan keeps a
			// fingerprint only while size and time still match it
			const same = prev.size === f.size && prev.mtimeMs === f.mtimeMs;
			const sha256 = mode === 'full' ? (f.sha256 ?? null) : same ? prev.sha256 : null;
			rows.push({ ...prev, path: f.path, kind: 'added', size: f.size, mtimeMs: f.mtimeMs, sha256 });
			counts.added++;
		} else fresh.push(f);
	}
	for (const f of [...fresh].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
		const { prefix, bundle } = rules(f.path);
		const width = Math.max(use.get(prefix)?.width ?? 0, 3);
		let n = (issued[prefix] ?? 0) + 1;
		while (input.takenRefs.has(`${prefix}-${String(n).padStart(width, '0')}`)) n++;
		issued[prefix] = n;
		const name = f.path.split('/').pop() ?? f.path;
		rows.push({ path: f.path, kind: 'added', ref: `${prefix}-${String(n).padStart(width, '0')}`, size: f.size, mtimeMs: f.mtimeMs, sha256: mode === 'full' ? (f.sha256 ?? null) : null, bundle, date: dateFromName(name), docType: docTypeOf(name), evidence: '', processing: 'pending' });
		counts.added++;
		counts.newlyAdded++;
	}
	// additions no longer in the folder keep their ref (never issued again) but are not shown as documents
	for (const r of previous) if ((r.kind === 'added' || r.kind === 'withdrawn') && !walkedBy.has(norm(r.path)) && !indexedBy.has(norm(r.path))) rows.push({ ...r, kind: 'withdrawn' });
	rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return { rows, issued, counts };
}

/** The verdict a scan supports. Only a full scan that found no difference and no addition says the folder matches the
 *  indexed originals; a quick scan says its contents were not compared, whatever it found. */
export function verdict(mode: ScanMode, c: ScanOutcome['counts']): { current: boolean; text: string } {
	const diff = c.added + c.changed + c.removed;
	if (mode === 'quick') return { current: false, text: diff ? 'The case folder differs from the analysis.' : 'No difference found by name and size; contents were not compared (quick scan), so this does not confirm the analysis is current. Run a full scan to compare contents.' };
	return diff ? { current: false, text: 'The case folder differs from the analysis.' } : { current: true, text: 'Full scan: every indexed original is unchanged and the folder holds no new file.' };
}
