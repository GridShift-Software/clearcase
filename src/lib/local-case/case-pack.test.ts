import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { synthHtml, synthOriginals, synthRoots } from '../../../tests/case-package/fixtures/synth.ts';
import { writeZip, type ZipEntrySpec } from '../../../tests/case-package/hostile/zip-writer.ts';
import { caseIdFrom, findMainHtml, listFolder } from './case-pack.server.ts';
import { ackFor, cleanup, service, tempRoot } from './test-support.ts';
import type { LocalCase } from './service.server.ts';

const roots: string[] = [];
const open: LocalCase[] = [];
afterEach(async () => {
	for (const lc of open.splice(0)) lc.shutdown();
	for (const r of roots.splice(0)) await cleanup(r);
});
async function setup(tag: string) {
	const root = await tempRoot(tag);
	roots.push(root);
	const lc = service(path.join(root, 'data'));
	open.push(lc);
	await lc.startup();
	const dest = path.join(root, 'dest');
	await mkdir(dest);
	return { root, lc, dest };
}

const enc = (s: string) => new TextEncoder().encode(s);
function packFiles(prefix = ''): Record<string, Uint8Array> {
	const html = synthHtml(synthRoots());
	const files: Record<string, Uint8Array> = { 'Workspace.html': html, 'Workspace (bundles update only).html': html, ...synthOriginals() };
	return Object.fromEntries(Object.entries(files).map(([p, b]) => [prefix + p, b]));
}
const zipOf = (files: Record<string, Uint8Array>, method = 0) => writeZip(Object.entries(files).map(([name, data]) => ({ name, data, method })));
async function writeTree(dir: string, files: Record<string, Uint8Array>) {
	for (const [p, b] of Object.entries(files)) {
		await mkdir(path.dirname(path.join(dir, p)), { recursive: true });
		await writeFile(path.join(dir, p), b);
	}
}
const failed = (r: Awaited<ReturnType<LocalCase['importCasePack']>>) => (r.kind === 'failed' ? r.message : `not failed: ${r.kind}`);

describe('folder listing', () => {
	it('lists subfolders and .zip files with sizes, never other files, hidden entries or contents', async () => {
		const root = await tempRoot('browse');
		roots.push(root);
		await mkdir(path.join(root, 'Case B'));
		await mkdir(path.join(root, 'case a'));
		await mkdir(path.join(root, '.hidden'));
		await writeFile(path.join(root, 'pack.ZIP'), new Uint8Array(1234));
		await writeFile(path.join(root, 'notes.txt'), 'secret text');
		await symlink(path.join(root, 'Case B'), path.join(root, 'link to b'));
		const l = await listFolder(root);
		expect(l.error).toBeNull();
		expect(l.entries.map((e) => [e.name, e.kind, e.size])).toEqual([['case a', 'folder', null], ['Case B', 'folder', null], ['link to b', 'folder', null], ['pack.ZIP', 'zip', 1234]]);
		expect(JSON.stringify(l)).not.toContain('secret text');
		expect(l.parent).toBe(path.dirname(root));
		expect(l.crumbs.at(-1)).toEqual({ name: path.basename(root), path: root });
		expect(l.crumbs[0]!.path).toBe('/');
		expect(l.shortcuts[0]!.name).toBe('Home');
		expect((await listFolder(path.join(root, 'missing'))).error).toMatch(/does not exist/);
		expect((await listFolder(path.join(root, 'notes.txt'))).error).toMatch(/not a folder/);
		expect((await listFolder('relative/path')).path).toBe(l.shortcuts[0]!.path);
	});
});

describe('workspace HTML and case id', () => {
	it('takes the one .html without a parenthesised variant, and refuses none or several, naming them', async () => {
		const root = await tempRoot('html');
		roots.push(root);
		await writeTree(root, { 'A_Workspace.html': enc('x'), 'A_Workspace (bundles update only).html': enc('x'), 'sub/Other.html': enc('x') });
		expect(await findMainHtml(root)).toBe(path.join(root, 'A_Workspace.html'));
		await writeFile(path.join(root, 'B.htm'), 'x');
		await expect(findMainHtml(root)).rejects.toThrow(/More than one workspace HTML.*A_Workspace\.html, B\.htm/);
		const none = await tempRoot('html-none');
		roots.push(none);
		await expect(findMainHtml(none)).rejects.toThrow(/No workspace HTML/);
		await writeFile(path.join(none, 'X (bundles update only).html'), 'x');
		await expect(findMainHtml(none)).rejects.toThrow(/only variants were found \(X \(bundles update only\)\.html\)/);
	});

	it('derives a case id the package schema allows from the folder name', () => {
		expect(caseIdFrom('ESS_DCS_Lawyer_Pack_v5-002')).toBe('ess_dcs_lawyer_pack_v5-002');
		expect(caseIdFrom('  Smith & Jones (2024) ')).toBe('smith-jones-2024');
		expect(caseIdFrom('Café Ünïcode')).toBe('cafe-unicode');
		expect(caseIdFrom('___')).toBe('case');
		expect(caseIdFrom('x'.repeat(100))).toHaveLength(64);
	});
});

describe('extraction', () => {
	const unsafe: [string, ZipEntrySpec][] = [
		['a ".." segment', { name: '../escaped.txt', data: enc('x') }],
		['a nested ".."', { name: 'a/../../escaped.txt', data: enc('x') }],
		['an absolute path', { name: '/tmp/escaped.txt', data: enc('x') }],
		['a drive letter', { name: 'C:/escaped.txt', data: enc('x') }],
		['a backslash path', { name: '..\\escaped.txt', data: enc('x') }],
		['a symlink', { name: 'link', data: enc('/etc/passwd'), mode: 0o120777 }],
	];
	for (const [what, entry] of unsafe) {
		it(`refuses a pack with ${what} and writes nothing`, async () => {
			const { root, lc, dest } = await setup('unsafe');
			const zip = path.join(root, 'pack.zip');
			await writeFile(zip, writeZip([{ name: 'Workspace.html', data: enc('x') }, entry]));
			expect(failed(await lc.importCasePack(zip, dest))).toMatch(/cannot be extracted: (unsafe entry name|symlink entry)/);
			expect(await readdir(dest)).toEqual([]);
			expect((await readdir(root)).sort()).toEqual(['data', 'dest', 'pack.zip']);
			expect(lc.store.listImports()).toEqual([]);
		});
	}

	it('refuses a non-empty target and leaves it as it was', async () => {
		const { root, lc, dest } = await setup('nonempty');
		const zip = path.join(root, 'My Pack.zip');
		await writeFile(zip, zipOf(packFiles()));
		await mkdir(path.join(dest, 'My Pack'));
		await writeFile(path.join(dest, 'My Pack', 'mine.txt'), 'keep');
		expect(failed(await lc.importCasePack(zip, dest))).toMatch(/My Pack already exists and holds other files than this pack.*open .*My Pack and choose Use this folder/);
		expect(await readdir(path.join(dest, 'My Pack'))).toEqual(['mine.txt']);
		expect(await readdir(dest)).toEqual(['My Pack']);
	});

	it('refuses a pack whose stored size or CRC lies, and keeps nothing', async () => {
		const { root, lc, dest } = await setup('crc');
		const zip = path.join(root, 'pack.zip');
		await writeFile(zip, writeZip([{ name: 'Workspace.html', data: enc('hello'), crc: 1 }]));
		expect(failed(await lc.importCasePack(zip, dest))).toMatch(/CRC-32 mismatch.*Nothing was kept/);
		expect(await readdir(dest)).toEqual([]);
	});

	it('names the single top folder as the copy to import when the target holds other files', async () => {
		const { root, lc, dest } = await setup('nonempty-top');
		const zip = path.join(root, 'pack.zip');
		await writeFile(zip, zipOf(packFiles('Inner/')));
		await mkdir(path.join(dest, 'pack'));
		await writeFile(path.join(dest, 'pack', 'mine.txt'), 'keep');
		expect(failed(await lc.importCasePack(zip, dest))).toContain(`open ${path.join(dest, 'pack', 'Inner')} and choose Use this folder`);
	});

	it('extracts an empty pack into an empty folder, then refuses it for its missing workspace HTML and removes the folder', async () => {
		const { root, lc, dest } = await setup('empty');
		const zip = path.join(root, 'empty.zip');
		await writeFile(zip, writeZip([]));
		expect(failed(await lc.importCasePack(zip, dest))).toMatch(/^No workspace HTML in .*empty\./);
		expect(await readdir(dest)).toEqual([]);
	});

	it('refuses a destination it may not write to, with a plain message, before reading the pack', async () => {
		const { root, lc, dest } = await setup('readonly');
		const zip = path.join(root, 'pack.zip');
		await writeFile(zip, zipOf(packFiles()));
		await chmod(dest, 0o555);
		try {
			expect(failed(await lc.importCasePack(zip, dest))).toBe(`ClearCase may not write to ${dest}. Store the case in a folder you can write to.`);
		} finally {
			await chmod(dest, 0o755);
		}
		expect(await readdir(dest)).toEqual([]);
	});

	it('stops on Cancel during extraction and removes the partial folder', async () => {
		const { root, lc, dest } = await setup('cancel');
		const zip = path.join(root, 'pack.zip');
		await writeFile(zip, zipOf(packFiles()));
		const run = lc.importCasePack(zip, dest);
		expect(lc.cancelImport()).toBe(true);
		expect(failed(await run)).toMatch(/cancelled/);
		expect(await readdir(dest)).toEqual([]);
		expect(lc.importProgress()).toBeNull();
	});
});

describe('destinations', () => {
	it('refuses a destination inside the data directory, the program folder or the case folder', async () => {
		const { root, lc } = await setup('dest');
		const caseDir = path.join(root, 'case');
		await writeTree(caseDir, packFiles());
		await mkdir(path.join(root, 'data', 'sub'), { recursive: true });
		expect(failed(await lc.importCasePack(caseDir, path.join(root, 'data', 'sub')))).toMatch(/inside the ClearCase data directory/);
		expect(failed(await lc.importCasePack(caseDir, process.cwd()))).toMatch(/inside ClearCase's own program folder/);
		expect(failed(await lc.importCasePack(caseDir, caseDir))).toMatch(/inside the case folder/);
		expect(failed(await lc.importCasePack(path.join(root, 'nope.zip'), root))).toMatch(/neither a folder nor a \.zip/);
		expect(lc.store.listImports()).toEqual([]);
	});
});

describe('the whole pipeline', () => {
	it('extracts a .zip, converts it beside the case, stores a candidate that activates', async () => {
		const { root, lc, dest } = await setup('zip');
		const zip = path.join(root, 'Synthetic_Pack_v5.zip');
		await writeFile(zip, zipOf(packFiles(), 8));
		const seen = new Set<string>();
		const poll = setInterval(() => { const p = lc.importProgress()?.progress; if (p) seen.add(p.phase); }, 1);
		const r = await lc.importCasePack(zip, dest);
		clearInterval(poll);
		expect(r.kind).toBe('stored');
		if (r.kind === 'failed') return;
		expect((await readdir(dest)).sort()).toEqual(['Synthetic_Pack_v5', 'Synthetic_Pack_v5-results']);
		const caseDir = path.join(dest, 'Synthetic_Pack_v5');
		for (const [p, b] of Object.entries(packFiles())) expect(new Uint8Array(await readFile(path.join(caseDir, p)))).toEqual(b);
		const imp = lc.store.getImport(r.importId)!;
		expect([imp.case_folder, imp.package_source, imp.case_id]).toEqual([caseDir, path.join(dest, 'Synthetic_Pack_v5-results'), 'synthetic_pack_v5']);
		expect(await lc.activate(imp.results_version!, ackFor(lc, r.importId))).toBeNull();
		expect(seen.has('extract')).toBe(true);
		const again = await lc.importCasePack(zip, dest);
		expect(again.kind).toBe('identical');
		expect((await readdir(dest)).sort()).toEqual(['Synthetic_Pack_v5', 'Synthetic_Pack_v5-results', 'Synthetic_Pack_v5-results-2']);
		const [original] = Object.keys(synthOriginals());
		const edited = Buffer.from(packFiles()[original!]!).map((x) => x ^ 0xff);
		await writeFile(path.join(caseDir, original!), edited);
		expect(failed(await lc.importCasePack(zip, dest))).toContain(`holds other files than this pack (${original} differs)`);
		expect(new Uint8Array(await readFile(path.join(caseDir, original!)))).toEqual(new Uint8Array(edited));
		await writeFile(path.join(caseDir, original!), packFiles()[original!]!);
		const html = Buffer.from(packFiles()['Workspace.html']!);
		const at = html.indexOf('Synthetic subject');
		expect(at).toBeGreaterThan(0);
		html.write('Different subject', at);
		await writeFile(zip, zipOf({ ...packFiles(), 'Workspace.html': html, 'Workspace (bundles update only).html': html }, 8));
		expect(failed(await lc.importCasePack(zip, dest))).toContain('holds other files than this pack (Workspace.html differs)');
		expect((await readdir(dest)).sort()).toEqual(['Synthetic_Pack_v5', 'Synthetic_Pack_v5-results', 'Synthetic_Pack_v5-results-2']);
		await writeFile(path.join(caseDir, 'Workspace.html'), 'changed');
		expect(failed(await lc.importCasePack(zip, dest))).toContain('holds other files than this pack (Workspace.html differs in size)');
		expect(await readFile(path.join(caseDir, 'Workspace.html'), 'utf8')).toBe('changed');
	});

	it('removes what it extracted when it fails or is cancelled after extraction, and a retry imports', async () => {
		const { root, lc, dest } = await setup('retry');
		const two = path.join(root, 'Two.zip');
		await writeFile(two, zipOf({ ...packFiles(), 'Second.html': enc('x') }));
		expect(failed(await lc.importCasePack(two, dest))).toMatch(/More than one workspace HTML/);
		expect(await readdir(dest)).toEqual([]);
		const zip = path.join(root, 'Pack.zip');
		await writeFile(zip, zipOf(packFiles(), 8));
		const run = lc.importCasePack(zip, dest);
		let phase = '';
		await new Promise<void>((done) => {
			const t = setInterval(() => {
				const p = lc.importProgress();
				if (!p) { clearInterval(t); done(); return; }
				if (p.progress && p.progress.phase !== 'extract') { phase = p.progress.phase; lc.cancelImport(); clearInterval(t); done(); }
			}, 0);
		});
		expect([phase !== '', failed(await run)]).toEqual([true, expect.stringMatching(/cancelled/)]);
		expect(await readdir(dest)).toEqual([]);
		expect(lc.store.listImports().filter((i) => i.verdict !== 'reject')).toEqual([]);
		const r = await lc.importCasePack(zip, dest, 'Smith v Jones');
		expect(r.kind).toBe('stored');
		if (r.kind === 'failed') return;
		expect((await readdir(dest)).sort()).toEqual(['Pack', 'Pack-results']);
		expect(lc.store.getVersion(lc.store.getImport(r.importId)!.results_version!)!.case_label).toBe('Smith v Jones');
	});

	it('uses the single top folder of a pack as the case folder', async () => {
		const { root, lc, dest } = await setup('top');
		const zip = path.join(root, 'pack.zip');
		await writeFile(zip, writeZip([{ name: 'Inner Case/' }, ...Object.entries(packFiles('Inner Case/')).map(([name, data]) => ({ name, data }))]));
		const r = await lc.importCasePack(zip, dest);
		expect(r.kind).toBe('stored');
		if (r.kind === 'failed') return;
		expect(lc.store.getImport(r.importId)!.case_folder).toBe(path.join(dest, 'pack', 'Inner Case'));
		expect((await readdir(dest)).sort()).toEqual(['Inner Case-results', 'pack']);
	});

	it('takes an extracted folder as it is, and a second run writes a new results folder and is identical', async () => {
		const { root, lc, dest } = await setup('folder');
		const caseDir = path.join(root, 'Extracted Case');
		await writeTree(caseDir, packFiles());
		const a = await lc.importCasePack(caseDir, dest);
		expect(a.kind).toBe('stored');
		const b = await lc.importCasePack(caseDir, dest);
		expect(b.kind).toBe('identical');
		expect((await readdir(dest)).sort()).toEqual(['Extracted Case-results', 'Extracted Case-results-2']);
		expect((await readdir(caseDir)).sort()).toEqual(Object.keys(packFiles()).map((p) => p.split('/')[0]!).filter((v, i, s) => s.indexOf(v) === i).sort());
	});

	it('stops with the names when the case has two workspace HTML files, and stores nothing', async () => {
		const { root, lc, dest } = await setup('two');
		const caseDir = path.join(root, 'case');
		await writeTree(caseDir, { ...packFiles(), 'Second.html': enc('x') });
		expect(failed(await lc.importCasePack(caseDir, dest))).toMatch(/More than one workspace HTML.*Second\.html, Workspace\.html/);
		expect(await readdir(dest)).toEqual([]);
		expect(lc.store.listImports()).toEqual([]);
	});

	// GRS-22 fix round, M4: a conversion the adapter refuses is a rejected import with its diagnostics, like a rejected package
	it('records a refused conversion as a rejected import, keeps the received HTML privately, and leaves nothing beside the case', async () => {
		const { root, lc, dest } = await setup('refused');
		const roots = synthRoots();
		roots.META.version = 'V9';
		const html = synthHtml(roots);
		const zip = path.join(root, 'Refused_Pack.zip');
		await writeFile(zip, zipOf({ 'Workspace.html': html, 'Workspace (bundles update only).html': html, ...synthOriginals() }, 8));
		const r = await lc.importCasePack(zip, dest);
		expect(r.kind).toBe('rejected');
		if (r.kind === 'failed') return;
		const imp = lc.store.getImport(r.importId)!;
		expect([imp.outcome, imp.verdict, imp.package_source]).toEqual(['rejected', 'reject', zip]);
		const report = JSON.parse(imp.report) as { verdict: string; caseLabel: string | null; diagnostics: { code: string; severity: string }[]; app: { code: string; severity: string; message: string }[]; counts: Record<string, number>; errorFingerprints: string[] };
		expect(report.verdict).toBe('reject');
		expect(report.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)).toEqual(['VER_UNSUPPORTED']);
		expect(report.counts).toEqual({ VER_UNSUPPORTED: 1 });
		expect(report.errorFingerprints).toHaveLength(1);
		expect(report.app.map((a) => [a.code, a.severity])).toEqual([['APP_CONVERSION_REFUSED', 'error']]);
		const kept = path.join(root, 'data', 'refused-inputs');
		const files = await readdir(kept);
		expect(files).toHaveLength(1);
		expect(report.app[0]!.message).toContain(path.join(kept, files[0]!));
		expect(new Uint8Array(await readFile(path.join(kept, files[0]!)))).toEqual(html);
		expect([(await stat(kept)).mode & 0o077, (await stat(path.join(kept, files[0]!))).mode & 0o077]).toEqual([0, 0]);
		expect(await readdir(dest)).toEqual([]);
		expect(lc.store.listImports().map((i) => i.outcome)).toEqual(['rejected']);
		const again = await lc.importCasePack(zip, dest);
		expect(again.kind).toBe('rejected');
		expect(await readdir(kept)).toEqual(files);
	});
});
