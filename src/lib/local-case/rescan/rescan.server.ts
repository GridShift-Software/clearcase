// Rescan & Update (GRS-20): walk the active version's case folder read-only, record how it differs from the results
// (rules.ts) in two user-work tables, and publish the additions through the document-row read contract, so the
// chronology, documents, search and counts show them without knowing about rescan.
//  * rescan_file (case scope): one row per difference, keyed by case, results version and path. An unchanged repeat
//    scan writes nothing, so a repeat scan is idempotent row for row.
//  * rescan_run (case scope): the last scan of a version (mode, time, counts, verdict) and the highest ref number
//    issued per prefix, so a cleared addition's ref is never issued again.
// Both are ordinary defined tables: Backup / Restore carries them like every other table.
// The walk skips hidden entries, symbolic links, anything that is not a regular file or folder, a processing package
// folder (manifest.json beside assets.json) and the ClearCase data directory. It reads file contents only in a full
// scan (SHA-256), never writes to the case folder, and stops at MAX_FILES.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';
import { now } from '../../components/clock.ts';
import { registerDocumentRowProvider, type ProviderRow } from '../documents.server.ts';
import type { ChronologyListRow, DocumentStateRow } from '../model.ts';
import { inTurn } from '../registers.server.ts';
import type { LocalCase } from '../service.server.ts';
import type { TableCell } from '../user-work.server.ts';
import { compare, verdict, type IndexedOriginal, type RescanFile, type ScanMode, type ScanOutcome, type WalkedFile } from './rules.ts';

export const OWNER = 'GRS-20';
export const FILE_TABLE = 'rescan_file';
export const RUN_TABLE = 'rescan_run';
export const PROVIDER_ID = 'rescanned';
export const MAX_FILES = 200_000;

const T = (name: string, notNull = false) => ({ name, type: 'TEXT' as const, notNull });
const I = (name: string) => ({ name, type: 'INTEGER' as const });

/** Define both tables (once per LocalCase). */
const defined = new WeakMap<LocalCase, Promise<void>>();
export function rescanTables(lc: LocalCase): Promise<void> {
	let p = defined.get(lc);
	if (!p) {
		p = (async () => {
			await lc.userWork.defineTable({
				name: FILE_TABLE, owner: OWNER, scope: 'case',
				description: 'Rescan & Update: files in the case folder that differ from the results version (added, withdrawn, changed, removed), keyed by path (GRS-20)',
				columns: [T('case_id', true), T('results_version', true), T('path', true), T('kind', true), T('ref', true), I('size'), I('mtime_ms'), T('sha256'), T('bundle'), T('date'), T('doc_type'), T('evidence'), T('processing')],
				primaryKey: ['case_id', 'results_version', 'path'],
			});
			await lc.userWork.defineTable({
				name: RUN_TABLE, owner: OWNER, scope: 'case',
				description: 'Rescan & Update: the last scan of a results version and the highest ref number issued per prefix (GRS-20)',
				columns: [T('case_id', true), T('results_version', true), T('mode', true), T('at', true), I('ms'), T('counts', true), T('issued', true), T('verdict', true)],
				primaryKey: ['case_id', 'results_version'],
			});
		})();
		p.catch(() => defined.delete(lc));
		defined.set(lc, p);
	}
	return p;
}

const isDefined = (lc: LocalCase, t: string) => lc.userWork.tables().some((x) => x.name === t && x.kind === 'user-work');
const num = (c: TableCell | undefined) => (typeof c === 'number' ? c : c && typeof c === 'object' && '$int' in c ? Number(c.$int) : null);
const str = (c: TableCell | undefined) => (typeof c === 'string' ? c : '');

export interface RunSummary { mode: ScanMode; at: string; ms: number; counts: ScanOutcome['counts']; issued: Record<string, number>; current: boolean; verdict: string }

/** The stored rows of one version (empty before the first scan). */
export function rescanRows(lc: LocalCase, caseId: string, resultsVersion: string): RescanFile[] {
	if (!isDefined(lc, FILE_TABLE)) return [];
	return lc.userWork.listTableRows(FILE_TABLE, { caseId }).filter((r) => r.results_version === resultsVersion).map((r) => ({
		path: str(r.path), kind: str(r.kind) as RescanFile['kind'], ref: str(r.ref), size: num(r.size), mtimeMs: num(r.mtime_ms), sha256: typeof r.sha256 === 'string' ? r.sha256 : null,
		bundle: str(r.bundle), date: str(r.date), docType: str(r.doc_type), evidence: str(r.evidence), processing: str(r.processing),
	}));
}
export function lastRun(lc: LocalCase, caseId: string, resultsVersion: string): RunSummary | null {
	if (!isDefined(lc, RUN_TABLE)) return null;
	const r = lc.userWork.listTableRows(RUN_TABLE, { caseId }).find((x) => x.results_version === resultsVersion);
	if (!r) return null;
	try {
		const v = JSON.parse(str(r.verdict));
		return { mode: str(r.mode) === 'full' ? 'full' : 'quick', at: str(r.at), ms: num(r.ms) ?? 0, counts: JSON.parse(str(r.counts)), issued: JSON.parse(str(r.issued)), current: v.current === true, verdict: String(v.text ?? '') };
	} catch { return null; }
}

/** The originals the version indexed and found, with their bundle, and every ref the version uses. */
function indexedOf(lc: LocalCase, resultsVersion: string): { indexed: IndexedOriginal[]; taken: Set<string> } {
	const { documents, assets } = lc.store.projectionRows(resultsVersion);
	const bundle = new Map<string, string>();
	for (const d of documents) {
		try { const b = (JSON.parse(d.row_json) as { bundle?: unknown }).bundle; bundle.set(d.ref, typeof b === 'string' ? b : ''); } catch { bundle.set(d.ref, ''); }
	}
	const indexed: IndexedOriginal[] = [];
	for (const a of assets) {
		if (a.kind !== 'file' || !a.real_path || a.status === 'missing') continue;
		indexed.push({ ref: a.key, path: a.real_path, size: a.size, sha256: a.sha256, bundle: bundle.get(a.key) ?? '' });
	}
	return { indexed, taken: new Set([...documents.map((d) => d.ref), ...assets.map((a) => a.key)]) };
}

async function sha256File(file: string): Promise<string> {
	const h = createHash('sha256');
	for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
	return h.digest('hex');
}

export class ScanError extends Error {}

/** Walk the case folder (read-only). `hash(rel, size)` says which files a full scan fingerprints. */
export async function walk(root: string, opts: { skip?: readonly string[]; hash?: (rel: string) => boolean } = {}): Promise<{ files: WalkedFile[]; skipped: number }> {
	const skip = new Set((opts.skip ?? []).map((p) => path.resolve(p)));
	const files: WalkedFile[] = [];
	let skipped = 0;
	const visit = async (dir: string, rel: string) => {
		if (skip.has(path.resolve(dir))) { skipped++; return; }
		const entries: { name: string; isFile: boolean; isDir: boolean }[] = [];
		for await (const e of await opendir(dir)) entries.push({ name: e.name, isFile: e.isFile(), isDir: e.isDirectory() });
		const names = new Set(entries.map((e) => e.name));
		// a processing package (or a copy of one) inside the case folder is not case material
		if (rel && names.has('manifest.json') && names.has('assets.json')) { skipped++; return; }
		for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
			if (e.name.startsWith('.') || (!e.isFile && !e.isDir)) { skipped++; continue; }
			const abs = path.join(dir, e.name);
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDir) { await visit(abs, r); continue; }
			if (files.length >= MAX_FILES) throw new ScanError(`the case folder holds more than ${MAX_FILES.toLocaleString('en-ZA')} files; the scan stopped and nothing was recorded`);
			try {
				const s = await stat(abs);
				files.push({ path: r, size: s.size, mtimeMs: Math.trunc(s.mtimeMs), sha256: opts.hash?.(r) ? await sha256File(abs) : null });
			} catch { skipped++; }
		}
	};
	await visit(root, '');
	return { files, skipped };
}

// one scan per case at a time, in the case's register queue: a restore of the case waits for a scan, and a scan for it
const serial = <T>(lc: LocalCase, caseId: string, fn: () => Promise<T>): Promise<T> => inTurn(lc.userWork, caseId, 'rescan\u0000', fn);

const cellsOf = (caseId: string, rv: string, r: RescanFile): Record<string, TableCell> => ({
	case_id: caseId, results_version: rv, path: r.path, kind: r.kind, ref: r.ref, size: r.size, mtime_ms: r.mtimeMs, sha256: r.sha256,
	bundle: r.bundle, date: r.date, doc_type: r.docType, evidence: r.evidence, processing: r.processing,
});
const same = (a: RescanFile, b: RescanFile) => JSON.stringify(a) === JSON.stringify(b);

export interface ScanResult extends RunSummary { rows: RescanFile[]; skipped: number }

/**
 * Scan the case folder of one version and record the result. Rows are written only where they changed and removed
 * only where they no longer apply; the run summary is replaced. One scan per case at a time.
 */
export function rescan(lc: LocalCase, resultsVersion: string, mode: ScanMode): Promise<ScanResult> {
	const v = lc.store.getVersion(resultsVersion);
	if (!v) return Promise.reject(new ScanError('unknown results version'));
	return serial(lc, v.case_id, async () => {
		await rescanTables(lc);
		const started = performance.now();
		const { indexed, taken } = indexedOf(lc, resultsVersion);
		const previous = rescanRows(lc, v.case_id, resultsVersion);
		const prevRun = lastRun(lc, v.case_id, resultsVersion);
		try {
			const s = await stat(v.case_root);
			if (!s.isDirectory()) throw new Error('not a folder');
		} catch { throw new ScanError(`the case folder ${v.case_folder} cannot be read; connect the drive that holds it and scan again`); }
		const { files, skipped } = await walk(v.case_root, { skip: [lc.config.dataDir], hash: mode === 'full' ? () => true : undefined });
		const out = compare({ mode, walked: files, indexed, previous, issued: prevRun?.issued ?? {}, takenRefs: taken });
		const prevBy = new Map(previous.map((r) => [r.path, r]));
		const nextPaths = new Set(out.rows.map((r) => r.path));
		for (const r of out.rows) {
			const p = prevBy.get(r.path);
			if (!p || !same(p, r)) await lc.userWork.putTableRow(FILE_TABLE, cellsOf(v.case_id, resultsVersion, r), { owner: OWNER });
		}
		for (const p of previous) if (!nextPaths.has(p.path)) await lc.userWork.deleteTableRow(FILE_TABLE, { case_id: v.case_id, results_version: resultsVersion, path: p.path }, { owner: OWNER });
		const ver = verdict(mode, out.counts);
		const ms = Math.round(performance.now() - started);
		const at = now().toISOString();
		await lc.userWork.putTableRow(RUN_TABLE, { case_id: v.case_id, results_version: resultsVersion, mode, at, ms, counts: JSON.stringify(out.counts), issued: JSON.stringify(out.issued), verdict: JSON.stringify(ver) }, { owner: OWNER });
		ensureRescanProvider(lc, v.case_id);
		return { mode, at, ms, counts: out.counts, issued: out.issued, current: ver.current, verdict: ver.text, rows: out.rows, skipped };
	});
}

/** Clear the additions of a version (v5 "Clear rescan additions"). Changed and removed originals stay reported, and
 *  the issued ref numbers are kept, so a cleared ref is never issued again. Returns how many were cleared. */
export function clearAdditions(lc: LocalCase, resultsVersion: string): Promise<number> {
	const v = lc.store.getVersion(resultsVersion);
	if (!v) return Promise.reject(new ScanError('unknown results version'));
	return serial(lc, v.case_id, async () => {
		let n = 0;
		for (const r of rescanRows(lc, v.case_id, resultsVersion)) {
			if (r.kind !== 'added' && r.kind !== 'withdrawn') continue;
			if (await lc.userWork.deleteTableRow(FILE_TABLE, { case_id: v.case_id, results_version: resultsVersion, path: r.path }, { owner: OWNER }) && r.kind === 'added') n++;
		}
		return n;
	});
}

/** A '/'-relative path as the import writes document URLs ('./' and each segment percent-encoded). */
export const urlOf = (p: string) => `./${p.split('/').map(encodeURIComponent).join('/')}`;

/** An addition as a document row: the v5 rescan row shape (L2809-2814) with the app's './' URL base. */
export function providerRow(r: RescanFile): ProviderRow {
	const filename = r.path.split('/').pop() ?? r.path;
	const url = urlOf(r.path);
	const row = { ref: r.ref, date: r.date, filename, subject: '', sender: '', to: '', cc: '', excerpt: '', doc_type: r.docType, bundle: r.bundle, amount: '', also_in: [], text_status: 'pending', url, refs: [], _new: true, path: r.path, processing: r.processing };
	const list: Omit<ChronologyListRow, 'ord'> = { ref: r.ref, date: r.date, dateType: null, dateSource: null, docType: r.docType, bundle: r.bundle, subject: '', filename, sender: '', to: '', excerpt: '', amount: '', alsoIn: [], url, textStatus: 'pending', parentRef: null, file: 'blocked', preview: 'none', attachments: 0 };
	const state: DocumentStateRow = { file: 'blocked', preview: 'none', text: 'pending', mediaType: null, flags: ['rescan', 'not-indexed', `processing-${r.processing || 'pending'}`], original: null, self: null };
	return { ref: r.ref, row, list, state };
}

/** The additions of a version as provider rows, in path order. */
export function additions(lc: LocalCase, caseId: string, resultsVersion: string): ProviderRow[] {
	return rescanRows(lc, caseId, resultsVersion).filter((r) => r.kind === 'added').map(providerRow);
}

let registered: { lc: LocalCase; undo: () => void } | null = null;
/**
 * Publish the additions of `lc` through the document-row read contract (provider 'rescanned', owner GRS-20). Called
 * by every page that can show rescan state (the overview's freshness loader, the system pages) and by a scan; a later
 * call with another LocalCase (tests) re-registers. An id already taken by someone else is left alone. It registers
 * only once `caseId` has an addition: a registered provider changes every document list's ETag, so until a scan finds
 * a file the lists and their ETags stay exactly the imported ones.
 */
export function ensureRescanProvider(lc: LocalCase, caseId: string): void {
	if (registered?.lc === lc) return;
	if (!isDefined(lc, FILE_TABLE) || !lc.userWork.listTableRows(FILE_TABLE, { caseId }).some((r) => r.kind === 'added')) return;
	registered?.undo();
	registered = null;
	try {
		const undo = registerDocumentRowProvider({
			id: PROVIDER_ID, owner: OWNER,
			rows: ({ caseId, resultsVersion }) => additions(lc, caseId, resultsVersion),
			revision: ({ caseId, resultsVersion }) => `r-${createHash('sha256').update(JSON.stringify(rescanRows(lc, caseId, resultsVersion).filter((r) => r.kind === 'added'))).digest('base64url').slice(0, 43)}`,
		});
		registered = { lc, undo };
	} catch { /* registered by another module instance: it serves the same rows */ }
}
