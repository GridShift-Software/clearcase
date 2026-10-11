// Backup / Restore (GRS-20): one case's user work as a single JSON file, generic over every table the user-work
// contract enumerates (UserWork.exportAll), so a table a later ticket defines is carried without code here.
//  * What is in it: every case-scoped table's rows of this case, every store-scoped table's rows (they belong to no
//    case), the table definitions, the case identity (case id, label, results version, input revision), the app's
//    format versions and a SHA-256 of the user-work payload. No binaries: originals, the results package and the
//    imported results are not in the file (`binaries: false`, said on the page and in the file).
//  * Accepted warnings (trusted_warning) are left out: a restore never creates trust (the contract drops them anyway).
//  * Restore is checked before anything is written: size, JSON, format and version, checksum, the case (every
//    case-table row must belong to the active case), and the contract's own restore checks. It takes a work.sqlite
//    backup first, then replaces this case's rows of every table in the file in one transaction (other cases' rows
//    are kept, store tables are merged by key). Any refusal or failure leaves the active data unchanged.
//  * A v5 browser backup (ess_dcs_backup.json: an object of ess_dcs_* keys) goes to the legacy import hook.
import { createHash } from 'node:crypto';
import { now } from '../../components/clock.ts';
import type { LocalCase } from '../../local-case/service.server.ts';
import { USER_WORK_EXPORT, UserWorkError, type ImportResult, type UserWorkExport } from '../../local-case/user-work.server.ts';
import { importLegacy, legacyBackup, type LegacyResult } from './legacy.server.ts';

export const BACKUP_FORMAT = 'clearcase.backup/1';
/** The largest backup file a restore reads. */
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
const CASE_COLUMN = 'case_id';
/** Tables never carried: a restore never creates trust. */
const NOT_CARRIED = new Set(['trusted_warning']);

export interface BackupFile {
	format: typeof BACKUP_FORMAT;
	createdAt: string;
	app: { name: 'ClearCase'; backupFormat: 1; userWorkFormat: typeof USER_WORK_EXPORT; build: string | null };
	case: { caseId: string; caseLabel: string | null; resultsVersion: string; inputRevisionId: string };
	binaries: false;
	note: string;
	counts: Record<string, number>;
	sha256: string;
	userWork: UserWorkExport;
}

export const BINARIES_NOTE = 'This file holds the user work of one case (notes, register entries and every other saved table) and the case identity. It does not hold the originals, the results package or the imported results: keep the case folder and the package to restore a case on another computer.';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The backup of one case, against the version the case shows (its active version, or `resultsVersion`). */
export function createBackup(lc: LocalCase, resultsVersion: string, build: string | null = null): BackupFile {
	const v = lc.store.getVersion(resultsVersion);
	if (!v) throw new BackupError('unknown results version');
	const all = lc.userWork.exportAll();
	const tables = all.tables
		.filter((t) => !NOT_CARRIED.has(t.name))
		.map((t) => ({ ...t, rows: t.scope === 'case' ? t.rows.filter((r) => r[CASE_COLUMN] === v.case_id) : t.rows }));
	const userWork: UserWorkExport = { format: USER_WORK_EXPORT, exportedAt: all.exportedAt, tables, ...(all.excluded?.length ? { excluded: all.excluded } : {}) };
	return {
		format: BACKUP_FORMAT,
		createdAt: now().toISOString(),
		app: { name: 'ClearCase', backupFormat: 1, userWorkFormat: USER_WORK_EXPORT, build },
		case: { caseId: v.case_id, caseLabel: v.case_label, resultsVersion: v.id, inputRevisionId: v.input_revision_id },
		binaries: false,
		note: BINARIES_NOTE,
		counts: Object.fromEntries(tables.map((t) => [t.name, t.rows.length])),
		sha256: sha(JSON.stringify(userWork)),
		userWork,
	};
}

/** A file name for a backup: the case id made safe, and the time. */
export function backupName(b: Pick<BackupFile, 'case' | 'createdAt'>): string {
	const id = b.case.caseId.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'case';
	return `clearcase-backup-${id}-${b.createdAt.slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}.json`;
}

export type BackupErrorCode = 'too-large' | 'not-json' | 'not-a-backup' | 'incompatible' | 'corrupt' | 'wrong-case' | 'refused' | 'legacy';
export class BackupError extends Error {
	readonly code: BackupErrorCode;
	constructor(message: string, code: BackupErrorCode = 'refused') {
		super(message);
		this.code = code;
	}
}

/** What a checked backup holds, for the page to show before and after a restore. */
export interface BackupSummary { createdAt: string; caseId: string; caseLabel: string | null; resultsVersion: string; sameVersion: boolean; tables: { name: string; rows: number }[]; rows: number }

/**
 * Check a backup file against the active case without writing anything. Refuses (BackupError) anything too large, not
 * JSON, not a ClearCase backup, of another format version, altered (checksum), or of another case.
 */
export function checkBackup(text: string, active: { caseId: string; resultsVersion: string }): { file: BackupFile; summary: BackupSummary } {
	if (Buffer.byteLength(text, 'utf8') > MAX_BACKUP_BYTES) throw new BackupError(`The file is larger than ${MAX_BACKUP_BYTES / 1024 / 1024} MiB, so it is not a ClearCase backup this version can restore. Nothing was changed.`, 'too-large');
	let o: unknown;
	try { o = JSON.parse(text); } catch { throw new BackupError('The file is not valid JSON (it may be truncated or damaged). Nothing was changed.', 'not-json'); }
	if (!isRecord(o)) throw new BackupError('The file is not a ClearCase backup. Nothing was changed.', 'not-a-backup');
	if (o.format !== BACKUP_FORMAT) {
		if (typeof o.format === 'string' && o.format.startsWith('clearcase.backup/')) throw new BackupError(`The file is a ClearCase backup of another format (${o.format.slice(0, 40)}); this version restores ${BACKUP_FORMAT} only. Nothing was changed.`, 'incompatible');
		if (legacyBackup(o)) throw new BackupError('legacy', 'legacy');
		throw new BackupError('The file is not a ClearCase backup. Nothing was changed.', 'not-a-backup');
	}
	const app = o.app, c = o.case, uw = o.userWork;
	if (!isRecord(app) || app.backupFormat !== 1 || app.userWorkFormat !== USER_WORK_EXPORT) throw new BackupError(`The backup was written for another user-work format (${String(isRecord(app) ? app.userWorkFormat : '').slice(0, 40)}); this version reads ${USER_WORK_EXPORT}. Nothing was changed.`, 'incompatible');
	if (!isRecord(c) || typeof c.caseId !== 'string' || typeof c.resultsVersion !== 'string' || !isRecord(uw) || uw.format !== USER_WORK_EXPORT || !Array.isArray(uw.tables)) throw new BackupError('The backup is incomplete or damaged (its case or user work is missing). Nothing was changed.', 'corrupt');
	if (typeof o.sha256 !== 'string' || sha(JSON.stringify(uw)) !== o.sha256) throw new BackupError('The backup was changed or damaged after it was written (its checksum does not match). Nothing was changed.', 'corrupt');
	if (c.caseId !== active.caseId) throw new BackupError('The backup belongs to another case. Open that case to restore it. Nothing was changed.', 'wrong-case');
	const tables: { name: string; rows: number }[] = [];
	for (const t of uw.tables as unknown[]) {
		if (!isRecord(t) || typeof t.name !== 'string' || !Array.isArray(t.rows)) throw new BackupError('The backup is damaged (a table entry is malformed). Nothing was changed.', 'corrupt');
		if (NOT_CARRIED.has(t.name)) throw new BackupError(`The backup carries ${t.name}, which a backup never holds. Nothing was changed.`, 'corrupt');
		if (t.scope === 'case' && (t.rows as unknown[]).some((r) => !isRecord(r) || r[CASE_COLUMN] !== active.caseId)) throw new BackupError(`The backup holds rows of another case (table ${t.name.slice(0, 80)}). Nothing was changed.`, 'wrong-case');
		tables.push({ name: t.name, rows: (t.rows as unknown[]).length });
	}
	const file = o as unknown as BackupFile;
	return { file, summary: { createdAt: String(o.createdAt ?? ''), caseId: c.caseId, caseLabel: typeof c.caseLabel === 'string' ? c.caseLabel : null, resultsVersion: c.resultsVersion, sameVersion: c.resultsVersion === active.resultsVersion, tables, rows: tables.reduce((n, t) => n + t.rows, 0) } };
}

export type RestoreOutcome = { kind: 'restored'; summary: BackupSummary; result: ImportResult } | { kind: 'legacy'; legacy: LegacyResult };

/**
 * Restore a backup into the active case: check it, back work.sqlite up, then replace this case's rows of the file's
 * tables in one transaction. A refusal (BackupError) or a failed write leaves the active data unchanged.
 */
export async function restoreBackup(lc: LocalCase, text: string, active: { caseId: string; resultsVersion: string }): Promise<RestoreOutcome> {
	let checked: ReturnType<typeof checkBackup>;
	try { checked = checkBackup(text, active); } catch (e) {
		if (e instanceof BackupError && e.code === 'legacy') return { kind: 'legacy', legacy: await importLegacy(lc, JSON.parse(text), active) };
		throw e;
	}
	lc.backupNow('pre-restore');
	// backupNow records a failure as a warning instead of throwing; a restore without its copy of the work is refused
	if (lc.warnings.has('backup-failed')) throw new BackupError('The current work could not be copied before the restore, so nothing was restored. Nothing was changed.', 'refused');
	try {
		const result = await lc.userWork.importAll(checked.file.userWork, { replace: 'cases' });
		return { kind: 'restored', summary: checked.summary, result };
	} catch (e) {
		if (e instanceof UserWorkError) throw new BackupError(`The backup cannot be restored here: ${e.message}. Nothing was changed.`, 'refused');
		throw e;
	}
}
