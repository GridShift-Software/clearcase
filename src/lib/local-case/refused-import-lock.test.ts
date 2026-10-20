// PR #76 review, GRS-22: a refused conversion keeps the import lock until its rejected-import row is written, so a
// second import of the same HTML cannot enter while the first still writes the kept copy and its attempt row.
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { synthHtml, synthOriginals, synthRoots } from '../../../tests/case-package/fixtures/synth.ts';
import type { LocalCase } from './service.server.ts';
import { cleanup, service, tempRoot } from './test-support.ts';

const roots: string[] = [];
const open: LocalCase[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const lc of open.splice(0)) lc.shutdown();
	for (const r of roots.splice(0)) await cleanup(r);
});

/** A case folder whose workspace HTML the converter refuses (an unsupported version), imported in place: nothing is created beside it. */
async function refusedFolder() {
	const root = await tempRoot('refused-lock');
	roots.push(root);
	const lc = service(path.join(root, 'data'));
	open.push(lc);
	await lc.startup();
	const caseDir = path.join(root, 'Refused_Case');
	const roots_ = synthRoots();
	roots_.META.version = 'V9';
	const html = synthHtml(roots_);
	const files: Record<string, Uint8Array> = { 'Workspace.html': html, 'Workspace (bundles update only).html': html, ...synthOriginals() };
	for (const [p, b] of Object.entries(files)) {
		await mkdir(path.dirname(path.join(caseDir, p)), { recursive: true });
		await writeFile(path.join(caseDir, p), b);
	}
	return { lc, caseDir, dest: path.join(root, 'dest') };
}

describe('importCasePack while a refused conversion is still being recorded', () => {
	it('answers a second import of the same HTML with the busy message until the first has written its attempt row', async () => {
		const { lc, caseDir, dest } = await refusedFolder();
		await mkdir(dest);
		const record = lc.store.recordRejected.bind(lc.store);
		let release!: () => void;
		const held = new Promise<void>((r) => { release = r; });
		let entered!: () => void;
		const writing = new Promise<void>((r) => { entered = r; });
		vi.spyOn(lc.store, 'recordRejected').mockImplementation(async (row) => { entered(); await held; return record(row); });
		const first = lc.importCasePack(caseDir, dest);
		await writing;
		try {
			const second = await Promise.race([lc.importCasePack(caseDir, dest), new Promise<'entered'>((r) => setTimeout(() => r('entered'), 400))]);
			expect(second).toEqual({ kind: 'failed', message: 'Another import is still running. Wait for it to finish or cancel it, then import again.' });
			expect(lc.importProgress()).not.toBeNull();
		} finally {
			release();
		}
		const done = await first;
		expect(done.kind).toBe('rejected');
		expect(lc.importProgress()).toBeNull();
		expect(lc.store.listImports().map((i) => i.outcome)).toEqual(['rejected']);
		const kept = path.join(lc.config.dataDir, 'refused-inputs');
		expect((await readdir(kept)).filter((n) => n.endsWith('.partial'))).toEqual([]);
		const again = await lc.importCasePack(caseDir, dest);
		expect(again.kind).toBe('rejected');
		expect(lc.store.listImports().map((i) => i.outcome)).toEqual(['rejected', 'rejected']);
	});
});
