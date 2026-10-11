// Drive steps of features/system-restore.md (GRS-20): export the case's work, clear the rescan addition, restore it by
// path, and refuse another case's backup. The files are written beside the synthetic case folder (the run's scratch).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const refs = (x) => x.page.evaluate(`[...document.querySelectorAll('#rescan-added tr[data-ref]')].map((r) => r.dataset.ref)`);
async function restore(x, path) {
	await x.click('#nav-backup_tab');
	await x.waitReady('backup_tab');
	await x.fill('#restore-path', path);
	await x.page.evaluate(`document.getElementById('restore-confirm').checked = true`);
	await x.click('#restore-submit');
	await x.page.waitFor(`!document.getElementById('restore-busy') && !!(document.getElementById('restore-done') || document.getElementById('restore-error'))`, 30000);
	return x.page.evaluate(`({ done: document.getElementById('restore-done')?.textContent.trim() ?? null, error: document.getElementById('restore-error')?.textContent.trim() ?? null, code: document.getElementById('restore-error')?.dataset.code ?? null })`);
}

export const steps = [
	{
		id: 'system-backup-export', feature: 'system-restore', title: 'Backup / Restore: Export all state downloads the case work without binaries',
		async run(x) {
			await x.click('#nav-backup_tab');
			await x.waitReady('backup_tab');
			const binaries = await x.text('#backup-binaries');
			const dl = await x.page.evaluate(`fetch(document.getElementById('backup-export').href).then(async (r) => ({ status: r.status, disposition: r.headers.get('content-disposition'), text: await r.text() }))`);
			const file = JSON.parse(dl.text);
			must(dl.status === 200 && /^Binaries are not included\./.test(binaries ?? '') && file.format === 'clearcase.backup/1' && file.binaries === false && file.case?.resultsVersion === x.synth.resultsVersion && file.counts?.rescan_file === 1, `export ${JSON.stringify({ status: dl.status, disposition: dl.disposition, format: file.format, binaries: file.binaries, counts: file.counts })}`);
			x.state.backupPath = join(dirname(x.synth.caseDir), 'clearcase-backup.json');
			writeFileSync(x.state.backupPath, dl.text);
			x.state.backup = file;
			return { disposition: dl.disposition, counts: file.counts, caseId: file.case.caseId };
		},
	},
	{
		id: 'system-restore', feature: 'system-restore', title: 'Clear the rescan addition, then Import state from the backup: the addition is back with its ref',
		async run(x) {
			await x.click('#nav-rescan_tab');
			await x.waitReady('rescan_tab');
			await x.page.evaluate(`document.getElementById('clear-confirm').checked = true`);
			await x.click('#rescan-clear');
			await x.page.waitFor(`!!document.getElementById('rescan-cleared')`, 20000);
			const cleared = await refs(x);
			const r = await restore(x, x.state.backupPath);
			const shot = await x.shot('system-restore-done');
			await x.click('#nav-rescan_tab');
			await x.waitReady('rescan_tab');
			const back = await refs(x);
			must(cleared.length === 0 && /^Restored /.test(r.done ?? '') && JSON.stringify(back) === '["OD-005"]', `restore ${JSON.stringify({ cleared, r, back })}`);
			return { cleared, ...r, back, shot };
		},
	},
	{
		id: 'system-restore-refused', feature: 'system-restore', title: 'Import state refuses another case\'s backup and changes nothing',
		async run(x) {
			const other = join(dirname(x.synth.caseDir), 'other-case-backup.json');
			writeFileSync(other, JSON.stringify({ ...x.state.backup, case: { ...x.state.backup.case, caseId: 'another-synthetic-case' } }));
			const r = await restore(x, other);
			const shot = await x.shot('system-restore-refused');
			await x.click('#nav-rescan_tab');
			await x.waitReady('rescan_tab');
			const after = await refs(x);
			must(r.code === 'wrong-case' && /Nothing was changed\.$/.test(r.error ?? '') && JSON.stringify(after) === '["OD-005"]', `refused ${JSON.stringify({ r, after })}`);
			return { ...r, after, shot };
		},
	},
];
