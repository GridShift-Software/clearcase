// Import, storage, activation and recovery of the local case service, on disposable data directories and synthetic
// cases converted by GRS-10's adapter. Behaviour under test is observable state: stored rows, the active pointer,
// the activation log, and what activation refuses.
import { DatabaseSync } from 'node:sqlite';
import { cp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalBytes } from '../case-package/canonical.ts';
import { decodeUtf8Strict, parseStrictJson } from '../case-package/strict-json.ts';
import { writePackageDir } from '../case-package/writer.ts';
import { buildCase } from '../../../tests/e2e/pilot/lib/fixtures.ts';
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
	return { root, lc };
}
const importOf = (lc: LocalCase, id: number) => JSON.parse(lc.store.getImport(id)!.report);
const count = (lc: LocalCase, table: string) => (lc.storage.db().prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Rewrite one package file canonically in place (manifest-only edits keep the resultsVersion). */
async function editPkgFile(pkgDir: string, file: string, edit: (v: any) => void) {
	const p = path.join(pkgDir, ...file.split('/'));
	const v = parseStrictJson(decodeUtf8Strict(new Uint8Array(await readFile(p)))) as any;
	edit(v);
	await writeFile(p, canonicalBytes(v));
}

describe('import', () => {
	it('stores exactly candidate.snapshot() with its projection in one version, and verifies it', async () => {
		const { root, lc } = await setup('store');
		const c = await buildCase(path.join(root, 'case1'));
		const out = await lc.importPackage(c.caseDir, c.pkgDir);
		expect(out.kind).toBe('stored');
		const v = lc.store.getVersion(c.resultsVersion)!;
		expect(v.case_id).toBe('e2e-case');
		const stored = lc.store.packageFiles(v.id);
		expect([...stored.keys()].sort()).toEqual([...c.files.keys()].sort());
		for (const [p, b] of c.files) expect(Buffer.compare(Buffer.from(stored.get(p)!), Buffer.from(b))).toBe(0);
		expect(lc.verify(v.id, true)).toMatchObject({ ok: true });
		expect(lc.store.projectionRows(v.id).documents).toHaveLength(7);
		expect(lc.currentActive()).toBeUndefined(); // importing never activates
	});

	it('a case folder restored at the same path is re-bound by importing the same package again', async () => {
		const { root, lc } = await setup('rebind');
		const c = await buildCase(path.join(root, 'c'));
		const imp = await lc.importPackage(c.caseDir, c.pkgDir);
		await rename(c.caseDir, `${c.caseDir}.old`);
		await cp(`${c.caseDir}.old`, c.caseDir, { recursive: true }); // same path, new inode
		expect((await lc.activate(c.resultsVersion, ackFor(lc, imp.importId)))?.message).toMatch(/moved or replaced/);
		expect(await lc.importPackage(c.caseDir, c.pkgDir)).toEqual({ kind: 'identical', importId: imp.importId });
		expect(await lc.activate(c.resultsVersion, ackFor(lc, imp.importId))).toBeNull();
	});

	it('a package with files its manifest does not list imports and activates; the ignored files are reported', async () => {
		const { root, lc } = await setup('unlisted');
		const c = await buildCase(path.join(root, 'c'));
		await writeFile(path.join(c.pkgDir, 'notes.txt'), 'not part of the package');
		const imp = await lc.importPackage(c.caseDir, c.pkgDir);
		expect(imp.kind).toBe('stored');
		const r = importOf(lc, imp.importId);
		expect(r.app).toEqual([expect.objectContaining({ code: 'APP_UNLISTED_IGNORED', severity: 'info' })]);
		expect(r.counts.PKG_UNLISTED_FILE).toBeUndefined(); // the stored report is the stored snapshot's
		expect([...lc.store.packageFiles(c.resultsVersion).keys()]).not.toContain('notes.txt');
		expect(await lc.activate(c.resultsVersion, ackFor(lc, imp.importId))).toBeNull();
	});

	it('a rejected import writes only its attempt row and leaves the active version unchanged', async () => {
		const { root, lc } = await setup('reject');
		const good = await buildCase(path.join(root, 'good'));
		const imp = await lc.importPackage(good.caseDir, good.pkgDir);
		expect(await lc.activate(good.resultsVersion, ackFor(lc, imp.importId))).toBeNull();
		const before = { versions: count(lc, 'version'), files: count(lc, 'package_file'), docs: count(lc, 'document') };
		const bad = await buildCase(path.join(root, 'bad'), { caseId: 'e2e-case' });
		await editPkgFile(bad.pkgDir, 'datasets/chronology.json', (env) => { env.data.pop(); }); // count and digest no longer agree
		const r = await lc.importPackage(bad.caseDir, bad.pkgDir);
		expect(r.kind).toBe('rejected');
		expect(importOf(lc, r.importId).verdict).toBe('reject');
		expect({ versions: count(lc, 'version'), files: count(lc, 'package_file'), docs: count(lc, 'document') }).toEqual(before);
		expect(lc.currentActive()?.vid).toBe(good.resultsVersion);
	});

	it('the same package again is a no-op; another manifest under the same resultsVersion is a conflict', async () => {
		const { root, lc } = await setup('idem');
		const c = await buildCase(path.join(root, 'c'));
		const first = await lc.importPackage(c.caseDir, c.pkgDir);
		const again = await lc.importPackage(c.caseDir, c.pkgDir);
		expect(again).toEqual({ kind: 'identical', importId: first.importId });
		await editPkgFile(c.pkgDir, 'manifest.json', (m) => { m.case.label = 'Another label'; }); // label is outside resultsVersion
		const conflict = await lc.importPackage(c.caseDir, c.pkgDir);
		expect(conflict.kind).toBe('rejected');
		expect(importOf(lc, conflict.importId).app.map((d: { code: string }) => d.code)).toEqual(['APP_VERSION_CONFLICT']);
		expect(lc.verify(c.resultsVersion, true).ok).toBe(true);
	});

	it('refuses a case folder that equals, contains or lies inside the data directory, and relative or missing paths', async () => {
		const { root, lc } = await setup('inputs');
		const c = await buildCase(path.join(root, 'c'));
		const codes = async (cf: string, pkg = c.pkgDir) => (await lc.checkInputs(cf, pkg)).app.map((d) => d.code);
		expect(await codes(lc.config.dataDir)).toEqual(['APP_CASE_FOLDER_OVERLAPS_DATA']);
		expect(await codes(root)).toEqual(['APP_CASE_FOLDER_OVERLAPS_DATA']);
		expect(await codes(lc.storage.backupDir)).toEqual(['APP_CASE_FOLDER_OVERLAPS_DATA']);
		expect(await codes('/')).toEqual(['APP_CASE_FOLDER_OVERLAPS_DATA']);
		const link = path.join(root, 'alias');
		await symlink(lc.config.dataDir, link);
		expect(await codes(link)).toEqual(['APP_CASE_FOLDER_OVERLAPS_DATA']);
		expect(await codes('relative/case')).toEqual(['APP_INPUT_INVALID']);
		expect(await codes(path.join(root, 'nope'))).toEqual(['APP_INPUT_INVALID']);
		expect(await codes(c.caseDir)).toEqual([]);
	});

	it('an original whose bytes no longer match is an import error, not an acknowledgeable warning', async () => {
		const { root, lc } = await setup('integrity');
		const c = await buildCase(path.join(root, 'c'));
		await writeFile(path.join(c.caseDir, 'DISCOVERY A', 'OD-001 Supply agreement.pdf'), '%PDF-1.4\n% changed after conversion\n%%EOF\n');
		const r = await lc.importPackage(c.caseDir, c.pkgDir);
		expect(r.kind).toBe('rejected');
		expect(importOf(lc, r.importId).counts.ORIG_FINGERPRINT_MISMATCH).toBe(1);
		expect(count(lc, 'version')).toBe(0);
	});
});

describe('activation', () => {
	it('needs an acknowledgement of every new warning on the first import, and records it bound to the result', async () => {
		const { root, lc } = await setup('ack');
		const c = await buildCase(path.join(root, 'c'));
		const imp = await lc.importPackage(c.caseDir, c.pkgDir);
		const report = importOf(lc, imp.importId);
		expect(report.verdict).toBe('report');
		expect(report.newWarnings.length).toBeGreaterThan(0);
		const refused = await lc.activate(c.resultsVersion, null);
		expect(refused?.reasons?.map((r) => r.code)).toEqual(['ACK_REQUIRED']);
		expect(lc.currentActive()).toBeUndefined();
		const partial = { ...ackFor(lc, imp.importId) };
		partial.warningFingerprints = partial.warningFingerprints.slice(1);
		expect((await lc.activate(c.resultsVersion, partial))?.reasons?.map((r) => r.code)).toEqual(['ACK_INCOMPLETE']);
		expect(await lc.activate(c.resultsVersion, ackFor(lc, imp.importId))).toBeNull();
		const log = lc.store.activationLog('e2e-case');
		expect(log).toHaveLength(1);
		const ack = JSON.parse(log[0]!.acknowledgement!);
		expect(ack).toMatchObject({ acknowledgement: 'clearcase.acknowledgement/1', resultsVersion: c.resultsVersion, manifestSha256: report.manifestSha256, diagnosticsSha256: report.diagnosticsSha256, validatorVersion: report.validatorVersion });
		expect(JSON.parse(log[0]!.accepted_warnings)).toEqual([...report.warningFingerprints].sort());
		expect(lc.currentActive()?.vid).toBe(c.resultsVersion);
	});

	it('a stale acknowledgement (other diagnostics or results) is refused', async () => {
		const { root, lc } = await setup('stale');
		const c = await buildCase(path.join(root, 'c'));
		const imp = await lc.importPackage(c.caseDir, c.pkgDir);
		const ack = ackFor(lc, imp.importId);
		expect((await lc.activate(c.resultsVersion, { ...ack, diagnosticsSha256: 'sha256:' + '0'.repeat(64) }))?.reasons?.map((r) => r.code)).toContain('ACK_STALE');
		expect((await lc.activate(c.resultsVersion, { ...ack, validatorVersion: 'other@1' }))?.reasons?.map((r) => r.code)).toContain('ACK_STALE');
		expect(lc.currentActive()).toBeUndefined();
	});

	it('carries accepted warnings forward: a reconversion with the same defects in another order needs no acknowledgement', async () => {
		const { root, lc } = await setup('carry');
		const v1 = await buildCase(path.join(root, 'v1'));
		const i1 = await lc.importPackage(v1.caseDir, v1.pkgDir);
		expect(await lc.activate(v1.resultsVersion, ackFor(lc, i1.importId))).toBeNull();
		// v2: same originals and defects, chronology reordered and one narrative character changed -> new resultsVersion
		const v2 = await buildCase(path.join(root, 'v2'), { caseDir: v1.caseDir, edit: (r) => { (r.DATA.chronology as unknown[]).reverse(); (r.DATA.matter as any).short = 'SYN2'; } });
		expect(v2.resultsVersion).not.toBe(v1.resultsVersion);
		const i2 = await lc.importPackage(v1.caseDir, v2.pkgDir);
		expect(importOf(lc, i2.importId).newWarnings).toEqual([]);
		expect(await lc.activate(v2.resultsVersion, null)).toBeNull();
		expect(lc.currentActive()?.vid).toBe(v2.resultsVersion);
	});

	it('a trusted register entry of case A never waives the same warning in case B', async () => {
		const { root, lc } = await setup('scope');
		const a = await buildCase(path.join(root, 'a'), { caseId: 'case-a' });
		const b = await buildCase(path.join(root, 'b'), { caseId: 'case-b' });
		const ia = await lc.importPackage(a.caseDir, a.pkgDir);
		const fps = importOf(lc, ia.importId).warningFingerprints as string[];
		await lc.store.addTrusted('case-a', fps);
		expect(lc.trustedFor('case-a').size).toBe(fps.length);
		expect(await lc.activate(a.resultsVersion, null)).toBeNull(); // waived by case A's register
		const ib = await lc.importPackage(b.caseDir, b.pkgDir);
		const rb = importOf(lc, ib.importId);
		// GRS-10 fingerprints are not bound to a case: the same synthetic defects give the same fingerprints
		expect(rb.warningFingerprints.filter((f: string) => fps.includes(f)).length).toBeGreaterThan(0);
		expect(rb.newWarnings).toEqual(rb.warningFingerprints);
		expect((await lc.activate(b.resultsVersion, null))?.reasons?.map((r) => r.code)).toEqual(['ACK_REQUIRED']);
		expect(lc.trustedFor('case-b').size).toBe(0);
	});

	it('refuses when an original changed or went missing since import, and when stored bytes or rows were altered', async () => {
		const { root, lc } = await setup('refuse');
		const c = await buildCase(path.join(root, 'c'));
		const imp = await lc.importPackage(c.caseDir, c.pkgDir);
		const ack = ackFor(lc, imp.importId);
		const pdf = path.join(c.caseDir, 'DISCOVERY A', 'OD-002 Invoice 1001.pdf');
		const original = await readFile(pdf);
		await writeFile(pdf, Buffer.from(original).fill(0x41, 10, 12)); // same size, other bytes
		expect((await lc.activate(c.resultsVersion, ack))?.message).toMatch(/revalidating .* rejects it/);
		await rm(pdf);
		expect((await lc.activate(c.resultsVersion, ack))?.message).toMatch(/no longer matches what was previewed/);
		await writeFile(pdf, original);
		const db = lc.storage.db();
		const blob = db.prepare("SELECT bytes FROM package_file WHERE version_id = ? AND path = 'assets.json'").get(c.resultsVersion) as { bytes: Uint8Array };
		const flipped = new Uint8Array(blob.bytes); flipped[5] ^= 1;
		db.prepare("UPDATE package_file SET bytes = ? WHERE version_id = ? AND path = 'assets.json'").run(flipped, c.resultsVersion);
		expect((await lc.activate(c.resultsVersion, ack))?.message).toMatch(/failed verification/);
		db.prepare("UPDATE package_file SET bytes = ? WHERE version_id = ? AND path = 'assets.json'").run(blob.bytes, c.resultsVersion);
		db.prepare("UPDATE document SET row_json = replace(row_json, 'Synthetic', 'Tampered') WHERE version_id = ? AND ref = 'OD-001'").run(c.resultsVersion);
		expect(lc.verify(c.resultsVersion, true)).toMatchObject({ ok: false, reason: expect.stringMatching(/read-model digest/) });
		expect((await lc.activate(c.resultsVersion, ack))?.message).toMatch(/failed verification/);
		expect(lc.currentActive()).toBeUndefined();
		// re-importing the same package repairs the stored copy
		expect((await lc.importPackage(c.caseDir, c.pkgDir)).kind).toBe('repaired');
		expect(lc.verify(c.resultsVersion, true).ok).toBe(true);
		expect(await lc.activate(c.resultsVersion, ackFor(lc, imp.importId))).toBeNull();
	});

	it('a re-import after an original went missing reports the current diagnostics and how to recover, never the stored report', async () => {
		const { root, lc } = await setup('stale');
		const c = await buildCase(path.join(root, 'c'));
		const imp = await lc.importPackage(c.caseDir, c.pkgDir);
		expect(importOf(lc, imp.importId).counts.ORIG_MISSING).toBeUndefined();
		const pdf = path.join(c.caseDir, 'DISCOVERY A', 'OD-002 Invoice 1001.pdf');
		const original = await readFile(pdf);
		await rm(pdf);
		const guidance = (message: string | undefined) => {
			expect(message).not.toMatch(/import the package again/i);
			expect(message).toMatch(/byte for byte/);
			expect(message).toMatch(/new results version/);
		};
		const refused = await lc.activate(c.resultsVersion, ackFor(lc, imp.importId));
		expect(refused?.message).toMatch(/no longer matches what was previewed/);
		guidance(refused?.message);
		// the re-import is a new attempt with the fresh diagnostics, not the first import returned as identical
		const again = await lc.importPackage(c.caseDir, c.pkgDir);
		expect(again.kind).toBe('rejected');
		expect(again.importId).not.toBe(imp.importId);
		const r = importOf(lc, again.importId);
		expect(r.counts.ORIG_MISSING).toBeGreaterThan(0);
		expect(r.diagnostics.map((d: { code: string }) => d.code)).toContain('ORIG_MISSING');
		expect(r.app.map((d: { code: string }) => d.code)).toEqual(['APP_ORIGINALS_CHANGED']);
		guidance(`${r.app[0].message}. ${r.app[0].hint}`);
		guidance((await lc.activate(c.resultsVersion, ackFor(lc, imp.importId)))?.message);
		expect(lc.verify(c.resultsVersion, true).ok).toBe(true); // the stored version is unchanged
		// restoring the original byte for byte makes the same package identical again, and it activates
		await writeFile(pdf, original);
		expect(await lc.importPackage(c.caseDir, c.pkgDir)).toEqual({ kind: 'identical', importId: imp.importId });
		expect(await lc.activate(c.resultsVersion, ackFor(lc, imp.importId))).toBeNull();
	});

	it('rollback checks the expected active version and target; a stale form changes nothing', async () => {
		const { root, lc } = await setup('rollback');
		const v1 = await buildCase(path.join(root, 'v1'));
		const v2 = await buildCase(path.join(root, 'v2'), { caseDir: v1.caseDir, edit: (r) => { (r.DATA.matter as any).short = 'V2'; } });
		const i1 = await lc.importPackage(v1.caseDir, v1.pkgDir);
		expect(await lc.activate(v1.resultsVersion, ackFor(lc, i1.importId))).toBeNull();
		await lc.importPackage(v1.caseDir, v2.pkgDir);
		expect(await lc.activate(v2.resultsVersion, null)).toBeNull();
		expect(lc.previousVersion('e2e-case')).toBe(v1.resultsVersion);
		expect((await lc.rollback('e2e-case', v1.resultsVersion, v1.resultsVersion))?.message).toMatch(/^Nothing was changed/);
		expect(await lc.rollback('e2e-case', v2.resultsVersion, v1.resultsVersion)).toBeNull();
		expect(lc.currentActive()?.vid).toBe(v1.resultsVersion);
		expect(lc.store.activationLog('e2e-case')[0]!.kind).toBe('rollback');
		expect((await lc.rollback('e2e-case', v2.resultsVersion, v1.resultsVersion))?.message).toMatch(/^Nothing was changed/);
		expect(lc.store.activationLog('e2e-case')).toHaveLength(3);
	});

	it('one backup per activation; concurrent activations of one candidate log once', async () => {
		const { root, lc } = await setup('backup');
		const c = await buildCase(path.join(root, 'c'));
		const imp = await lc.importPackage(c.caseDir, c.pkgDir);
		const ack = ackFor(lc, imp.importId);
		const results = await Promise.all(Array.from({ length: 5 }, () => lc.activate(c.resultsVersion, ack)));
		expect(results).toEqual([null, null, null, null, null]);
		expect(lc.store.activationLog('e2e-case')).toHaveLength(1);
		const backups = (await import('node:fs')).readdirSync(lc.storage.backupDir).filter((n) => n.startsWith('work-'));
		expect(backups).toHaveLength(1);
		const b = new DatabaseSync(path.join(lc.storage.backupDir, backups[0]!), { readOnly: true });
		expect((b.prepare('SELECT version_id FROM active').get() as { version_id: string }).version_id).toBe(c.resultsVersion);
		b.close();
	});
});

describe('startup and retention', () => {
	it('falls back with a banner when the active pointer was changed outside ClearCase, and adopting rewrites it', async () => {
		const { root, lc } = await setup('recover');
		const v1 = await buildCase(path.join(root, 'v1'));
		const v2 = await buildCase(path.join(root, 'v2'), { caseDir: v1.caseDir, edit: (r) => { (r.DATA.matter as any).short = 'V2'; } });
		const i1 = await lc.importPackage(v1.caseDir, v1.pkgDir);
		expect(await lc.activate(v1.resultsVersion, ackFor(lc, i1.importId))).toBeNull();
		await lc.importPackage(v1.caseDir, v2.pkgDir); // stored, never activated
		lc.storage.db().prepare('UPDATE work.active SET version_id = ?').run(v2.resultsVersion);
		await lc.startup();
		expect(lc.anyRecovery()).toMatchObject({ configured: v2.resultsVersion, effective: v1.resultsVersion });
		expect(lc.currentActive()?.vid).toBe(v1.resultsVersion);
		expect(await lc.adoptRecovery('e2e-case')).toBeNull();
		await lc.startup();
		expect(lc.anyRecovery()).toBeUndefined();
		expect(lc.store.activeVersionId('e2e-case')).toBe(v1.resultsVersion);
	});

	it('keeps a bounded number of never-activated candidates and never reuses a retired id for other content', async () => {
		const root = await tempRoot('retain');
		roots.push(root);
		const lc = service(path.join(root, 'data'), { CLEARCASE_KEEP_CANDIDATES: '1' });
		open.push(lc);
		await lc.startup();
		const a = await buildCase(path.join(root, 'a'));
		const b = await buildCase(path.join(root, 'b'), { caseDir: a.caseDir, edit: (r) => { (r.DATA.matter as any).short = 'B'; } });
		await lc.importPackage(a.caseDir, a.pkgDir);
		await lc.importPackage(a.caseDir, b.pkgDir);
		expect(lc.store.getVersion(a.resultsVersion)).toBeUndefined();
		expect(lc.store.getVersion(b.resultsVersion)).toBeDefined();
		// same resultsVersion as the retired one, different manifest bytes (label outside the identity)
		const files = new Map(a.files);
		const m = parseStrictJson(decodeUtf8Strict(files.get('manifest.json')!)) as any;
		m.case.label = 'relabelled';
		files.set('manifest.json', canonicalBytes(m));
		const relabelled = path.join(root, 'relabelled');
		await writePackageDir(relabelled, files);
		const r = await lc.importPackage(a.caseDir, relabelled);
		expect(importOf(lc, r.importId).app.map((d: { code: string }) => d.code)).toEqual(['APP_VERSION_RETIRED']);
		expect((await lc.importPackage(a.caseDir, a.pkgDir)).kind).toBe('stored'); // the same package may come back
	});
});

describe('case list', () => {
	it('lists every stored case, most recently activated first, with its status, counts and where Open goes', async () => {
		const { root, lc } = await setup('cases');
		expect(lc.listCases()).toEqual([]);
		const a = await buildCase(path.join(root, 'a'));
		const b = await buildCase(path.join(root, 'b'), { caseId: 'other-case' });
		const impA = await lc.importPackage(a.caseDir, a.pkgDir);
		const impB = await lc.importPackage(b.caseDir, b.pkgDir);
		const row = (c: typeof a, importId: number) => {
			const v = lc.store.getVersion(c.resultsVersion)!;
			return { id: c.resultsVersion, importId, created: v.created, storedAt: v.stored_at, documents: 7 };
		};
		expect(lc.listCases()).toEqual([
			{ caseId: 'other-case', caseLabel: null, status: 'candidate', versions: 1, href: `/import/${impB.importId}`, version: row(b, impB.importId) },
			{ caseId: 'e2e-case', caseLabel: null, status: 'candidate', versions: 1, href: `/import/${impA.importId}`, version: row(a, impA.importId) },
		]);

		expect(await lc.activate(a.resultsVersion, ackFor(lc, impA.importId))).toBeNull();
		expect(lc.listCases().map((c) => [c.caseId, c.status, c.href])).toEqual([
			['e2e-case', 'active', `/v/${encodeURIComponent(a.resultsVersion)}/overview`],
			['other-case', 'candidate', `/import/${impB.importId}`],
		]);
		expect(await lc.activate(b.resultsVersion, ackFor(lc, impB.importId))).toBeNull();
		expect(lc.listCases().map((c) => [c.caseId, c.status])).toEqual([['other-case', 'active'], ['e2e-case', 'active']]);

		lc.storage.db().prepare("UPDATE document SET row_json = replace(row_json, 'Synthetic', 'Tampered') WHERE version_id = ? AND ref = 'OD-001'").run(a.resultsVersion);
		await lc.startup();
		expect(lc.listCases().map((c) => [c.caseId, c.status, c.href, c.version.id])).toEqual([
			['other-case', 'active', `/v/${encodeURIComponent(b.resultsVersion)}/overview`, b.resultsVersion],
			['e2e-case', 'recovery', '/recovery', a.resultsVersion],
		]);
	});

	it('lists a case whose stored overview is damaged, with its document count unknown', async () => {
		const { root, lc } = await setup('cases-damaged');
		const a = await buildCase(path.join(root, 'a'));
		const b = await buildCase(path.join(root, 'b'), { caseId: 'other-case' });
		await lc.importPackage(a.caseDir, a.pkgDir);
		await lc.importPackage(b.caseDir, b.pkgDir);
		const db = lc.storage.db();
		db.prepare("UPDATE version SET overview = '{\"counts\":' WHERE id = ?").run(a.resultsVersion);
		db.prepare('UPDATE version SET overview = \'{"counts":{"documents":"7"}}\' WHERE id = ?').run(b.resultsVersion);
		expect(lc.listCases().map((c) => [c.caseId, c.version.documents])).toEqual([['other-case', null], ['e2e-case', null]]);
	});
});
