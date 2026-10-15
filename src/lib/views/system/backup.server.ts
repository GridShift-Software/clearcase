import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { error, fail, isHttpError } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import type { LocalCase } from '$lib/local-case/service.server';
import { ensureRescanProvider } from '$lib/local-case/rescan/rescan.server';
import { BackupError, BINARIES_NOTE, MAX_BACKUP_BYTES, backupName, createBackup, restoreBackup } from '$lib/user-work/backup/backup.server';
import { registerV5Importers } from '$lib/user-work/backup/v5-importers.server';
import { V5_LEGACY_KEYS, V5_STORES } from '$lib/user-work/backup/v5-keys';

type Event = { params: Record<string, string>; request: Request };

function versionOf(vid: string) {
	const a = app();
	const v = a.store.getVersion(vid);
	if (!v) error(404, 'Unknown results version');
	ensureRescanProvider(a, v.case_id);
	registerV5Importers();
	return { a, v };
}

export function backupPage(a: LocalCase, vid: string) {
	const v = a.store.getVersion(vid)!;
	const b = createBackup(a, v.id);
	const owner = new Map(b.userWork.tables.map((t) => [t.name, t.owner]));
	return {
		tables: Object.entries(b.counts).map(([name, rows]) => ({ name, rows, owner: owner.get(name) ?? '' })),
		rows: Object.values(b.counts).reduce((n, x) => n + x, 0),
		excluded: (b.userWork.excluded ?? []).map((x) => ({ name: x.name, rows: x.rows, reason: x.reason })),
		name: backupName(b),
		note: BINARIES_NOTE,
		maxBytes: MAX_BACKUP_BYTES,
		v5: { stores: V5_STORES.length, legacy: V5_LEGACY_KEYS.length },
	};
}

export const load = async ({ params }: { params: Record<string, string> }) => {
	const { a, v } = versionOf(params.vid);
	return backupPage(a, v.id);
};

export function backupFile(vid: string, build: string | null): { name: string; body: string } {
	const { a, v } = versionOf(vid);
	const b = createBackup(a, v.id, build);
	return { name: backupName(b), body: `${JSON.stringify(b, null, 2)}\n` };
}

async function fileText(f: FormData): Promise<string | { refused: string }> {
	const up = f.get('file');
	const typed = String(f.get('path') ?? '').trim();
	if (up instanceof File && up.size > 0) {
		if (up.size > MAX_BACKUP_BYTES) return { refused: `The file is larger than ${MAX_BACKUP_BYTES / 1024 / 1024} MiB, so it is not a backup this version can restore. Nothing was changed.` };
		return up.text();
	}
	if (!typed) return { refused: 'Choose a backup file, or type the path of one. Nothing was changed.' };
	if (!path.isAbsolute(typed)) return { refused: 'Type the full path of the backup file (for example /home/me/clearcase-backup.json). Nothing was changed.' };
	try {
		const s = await stat(typed);
		if (!s.isFile()) return { refused: 'That path is not a file. Nothing was changed.' };
		if (s.size > MAX_BACKUP_BYTES) return { refused: `The file is larger than ${MAX_BACKUP_BYTES / 1024 / 1024} MiB, so it is not a backup this version can restore. Nothing was changed.` };
		return await readFile(typed, 'utf8');
	} catch { return { refused: 'That file cannot be read. Check the path and try again. Nothing was changed.' }; }
}

export const actions = {
	restore: async ({ params, request }: Event) => {
		const { a, v } = versionOf(params.vid);
		const f = await request.formData();
		const typed = String(f.get('path') ?? '').slice(0, 4096);
		if (f.get('confirm') !== 'yes') return fail(400, { message: 'Tick “Yes, replace this case’s work” to restore. Nothing was changed.', path: typed });
		const text = await fileText(f);
		if (typeof text !== 'string') return fail(400, { message: text.refused, path: typed });
		try {
			const out = await restoreBackup(a, text, { caseId: v.case_id, resultsVersion: v.id });
			if (out.kind === 'legacy') return { legacy: out.legacy };
			return { restored: { createdAt: out.summary.createdAt, rows: out.summary.rows, tables: out.summary.tables.length, sameVersion: out.summary.sameVersion, resultsVersion: out.summary.resultsVersion, preRestore: out.preRestore } };
		} catch (e) {
			if (e instanceof BackupError) return fail(e.code === 'wrong-case' || e.code === 'refused' ? 409 : 400, { message: e.message, code: e.code, path: typed });
			if (isHttpError(e)) return fail(e.status, { message: e.body.message, code: 'busy', path: typed });
			throw e;
		}
	},
};
