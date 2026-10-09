// Import-time scenarios through the real server: S32, S34-S39, S41, S42, size/limit gates with sparse files (proved
// unread through /proc/<pid>/io), cancellation of a running import, an unrelated big file never read, and the data
// directory resolution (CLEARCASE_DATA_DIR, XDG default, relative XDG ignored). Each in its own data directory.
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { row } from '../lib/fixtures.ts';
import { editManifestOnly, editPackage, resealFiles } from '../../../case-package/fixtures/build.ts';
import { writePackageDir } from '../../../../src/lib/case-package/writer.ts';

const MAIN_COUNT_SQL = 'SELECT (SELECT count(*) FROM version) AS versions, (SELECT count(*) FROM package_file) AS files';

export default async function importScenarios(ctx) {
	const { S, verdict, pool, sub, mk, L, c1, c2, T } = ctx;
	const v1 = c1.resultsVersion;
	const copyCase = (name) => { const d = join(sub(name), 'case'); cpSync(c1.caseDir, d, { recursive: true }); return d; };
	const pkgFrom = async (dir, files) => { await writePackageDir(dir, files); return dir; };
	const rchar = (pid) => L.procIo(pid).rchar;
	const alive = async (s) => (await s.c.health()).instance?.pid === s.pid;

	await S('S32', 'a case folder that equals, lies inside or contains the data directory (also through a symlink) -> APP_CASE_FOLDER_OVERLAPS_DATA; nothing stored or served', async () => {
		const base = sub('s32');
		const data = join(base, 'data');
		const s = await pool.up(data, { name: 's32' });
		cpSync(c1.caseDir, data, { recursive: true }); // the originals are really there
		symlinkSync(data, join(base, 'link-to-data'));
		const tries = {};
		for (const [k, cf] of [['equal', data], ['inside', join(data, 'backups')], ['containing', base], ['symlink', join(base, 'link-to-data')]]) {
			const imp = await s.c.importPkg(cf, c1.pkgDir);
			const rep = await s.c.report(imp.importId);
			tries[k] = { verdict: rep.verdict, appCodes: rep.appCodes };
		}
		const counts = L.q1(data, MAIN_COUNT_SQL);
		const served = (await s.o.get(`/o/${v1}/OD-001/x`)).status;
		return verdict({ allRejected: Object.values(tries).every((t) => t.verdict === 'reject' && t.appCodes.includes('APP_CASE_FOLDER_OVERLAPS_DATA')), nothingStored: counts.versions === 0 && counts.files === 0, notServed: served === 404 },
			{ tries, counts, served });
	});

	await S('S39', "case folder '/' is refused clearly (APP_CASE_FOLDER_OVERLAPS_DATA, the data directory lies inside it), never read", async () => {
		const data = join(sub('s39'), 'data');
		const s = await pool.up(data, { name: 's39' });
		const r0 = rchar(s.pid);
		const imp = await s.c.importPkg('/', c1.pkgDir);
		const rep = await s.c.report(imp.importId);
		const read = rchar(s.pid) - r0;
		return verdict({ rejected: rep.verdict === 'reject', overlaps: rep.appCodes.includes('APP_CASE_FOLDER_OVERLAPS_DATA'), noEscapeDiag: !rep.codes.ORIG_ESCAPE, explained: /data directory/.test(rep.html), barelyRead: read < 8 * L.MiB, nothingStored: L.q1(data, MAIN_COUNT_SQL).versions === 0 },
			{ appCodes: rep.appCodes, codes: rep.codes, rcharDelta: read });
	});

	await S('S34', 'hostile package structure (JSON nested 100000 deep, a lone surrogate, folders nested 40 deep, malformed JSON) -> recorded rejection with a GRS-10 error code, never 500, server alive', async () => {
		const base = sub('s34');
		const data = join(base, 'data');
		const s = await pool.up(data, { name: 's34' });
		const deep = new Map(c1.files); deep.set('datasets/witnesses.json', new TextEncoder().encode('{"count":1,"data":' + '['.repeat(100000) + ']'.repeat(100000) + '}'));
		const surrogate = editPackage(c1.files, 'datasets/chronology.json', () => {});
		{ const t = Buffer.from(surrogate.get('datasets/chronology.json')).toString('utf8').replace('Synthetic subject OD-001', 'Synthetic \\ud800 subject'); surrogate.set('datasets/chronology.json', new TextEncoder().encode(t)); }
		const malformed = new Map(c1.files); malformed.set('datasets/people.json', new TextEncoder().encode('{"count":1,"data":[{"name":"x",}]}'));
		const variants = { deep: resealFiles(deep), surrogate: resealFiles(surrogate), malformed: resealFiles(malformed) };
		const out = {};
		for (const [k, files] of Object.entries(variants)) {
			const pk = await pkgFrom(join(base, `pkg-${k}`), files);
			const imp = await s.c.importPkg(c1.caseDir, pk);
			const rep = imp.importId ? await s.c.report(imp.importId) : null;
			out[k] = { status: imp.status, verdict: rep?.verdict, errors: rep ? Object.entries(rep.codes).filter(([, v]) => v === 'error').map(([c]) => c) : null };
		}
		// 40 nested folders inside the package (unlisted) and an asset path 40 segments deep
		const nestPk = join(base, 'pkg-nested');
		cpSync(c1.pkgDir, nestPk, { recursive: true });
		const nested = join(nestPk, ...Array.from({ length: 40 }, (_, i) => `d${i}`));
		mkdirSync(nested, { recursive: true }); writeFileSync(join(nested, 'x.json'), '{}');
		const deepPath = editPackage(c1.files, 'assets.json', (v) => { v.assets['OD-001'].path = Array.from({ length: 40 }, (_, i) => `d${i}`).join('/') + '/OD-001.pdf'; });
		const pkDeepPath = await pkgFrom(join(base, 'pkg-deep-asset-path'), deepPath);
		for (const [k, pk] of [['nestedFolders', nestPk], ['deepAssetPath', pkDeepPath]]) {
			const imp = await s.c.importPkg(c1.caseDir, pk);
			const rep = imp.importId ? await s.c.report(imp.importId) : null;
			out[k] = { status: imp.status, verdict: rep?.verdict, errors: rep ? Object.entries(rep.codes).filter(([, v]) => v === 'error').map(([c]) => c) : null, codes: rep?.codes };
		}
		const rec = (r) => r.status === 303 && r.verdict === 'reject' && r.errors.length > 0;
		return verdict({ deep: rec(out.deep), surrogate: rec(out.surrogate), malformed: rec(out.malformed), deepAssetPath: rec(out.deepAssetPath),
			nestedFoldersNever500: out.nestedFolders.status === 303 && out.nestedFolders.verdict !== undefined, alive: await alive(s) }, out);
	});

	await S('S35', 'size gates: a 2 MiB manifest and a 100 MiB (sparse) listed file are rejected PKG_TOO_LARGE before being read (server read_bytes/rchar delta)', async () => {
		const base = sub('s35');
		const data = join(base, 'data');
		const s = await pool.up(data, { name: 's35' });
		const bigManifest = join(base, 'pkg-big-manifest');
		cpSync(c1.pkgDir, bigManifest, { recursive: true });
		const m = readFileSync(join(bigManifest, 'manifest.json'), 'utf8');
		writeFileSync(join(bigManifest, 'manifest.json'), m.replace(/\}\s*$/, ' '.repeat(2 * L.MiB) + '}'));
		const bigFile = join(base, 'pkg-big-file');
		cpSync(c1.pkgDir, bigFile, { recursive: true });
		L.sparse(join(bigFile, 'datasets', 'chronology.json'), 100 * L.MiB);
		const out = {};
		for (const [k, pk] of [['manifest2MiB', bigManifest], ['file100MiB', bigFile]]) {
			const r0 = rchar(s.pid);
			const imp = await s.c.importPkg(c1.caseDir, pk);
			const read = rchar(s.pid) - r0;
			const rep = await s.c.report(imp.importId);
			out[k] = { verdict: rep.verdict, codes: rep.codes, rcharDelta: read, ms: Math.round(imp.ms) };
		}
		return verdict({ manifestRejected: out.manifest2MiB.verdict === 'reject' && out.manifest2MiB.codes.PKG_TOO_LARGE === 'error', manifestUnread: out.manifest2MiB.rcharDelta < 1 * L.MiB,
			fileRejected: out.file100MiB.verdict === 'reject' && out.file100MiB.codes.PKG_TOO_LARGE === 'error', fileUnread: out.file100MiB.rcharDelta < 16 * L.MiB, nothingStored: L.q1(data, MAIN_COUNT_SQL).versions === 0 }, out);
	});

	await S('S36', 'count and schema errors reject; an original whose bytes differ from its sha256 is an ERROR (ORIG_FINGERPRINT_MISMATCH): rejected, no candidate, activation impossible even with its fingerprint acknowledged, nothing served', async () => {
		const base = sub('s36');
		const data = join(base, 'data');
		const s = await pool.up(data, { name: 's36' });
		const countLie = await pkgFrom(join(base, 'pkg-count'), resealFiles(c1.files, (m) => { m.files.find((f) => f.path === 'datasets/chronology.json').count = 99; }));
		const schema = await pkgFrom(join(base, 'pkg-schema'), editPackage(c1.files, 'datasets/chronology.json', (v) => { v.data[0].date = 12345; v.data[1].attachments = 'not-a-list'; }));
		const out = {};
		for (const [k, pk] of [['countLie', countLie], ['schema', schema]]) {
			const imp = await s.c.importPkg(c1.caseDir, pk);
			const rep = await s.c.report(imp.importId);
			out[k] = { verdict: rep.verdict, errors: Object.entries(rep.codes).filter(([, v]) => v === 'error').map(([c]) => c) };
		}
		const cd = copyCase('s36');
		L.patchInPlace(join(cd, 'DISCOVERY A', 'OD-001 Supply agreement.pdf'), 12, Buffer.from('ZZZ'));
		const imp = await s.c.importPkg(cd, c1.pkgDir);
		const rep = await s.c.report(imp.importId);
		const stored = L.q1(data, MAIN_COUNT_SQL);
		const errFp = /data-code="ORIG_FINGERPRINT_MISMATCH"/.test(rep.html);
		const report = JSON.parse(L.q1(data, 'SELECT report FROM import_attempt WHERE id = ?', imp.importId).report);
		const forged = [['resultsVersion', v1], ['manifestSha256', report.manifestSha256 ?? ''], ['diagnosticsSha256', report.diagnosticsSha256], ['validatorVersion', report.validatorVersion], ...report.errorFingerprints.map((f) => ['fp', f]), ...report.warningFingerprints.map((f) => ['fp', f]), ['ack', 'on']];
		const act = await s.c.form(`/import/${imp.importId}?/activate`, forged);
		const served = (await s.o.get(`/o/${v1}/OD-001/x`)).status;
		return verdict({
			countLieRejected: out.countLie.verdict === 'reject' && out.countLie.errors.length > 0, schemaRejected: out.schema.verdict === 'reject' && out.schema.errors.length > 0,
			mismatchIsError: rep.verdict === 'reject' && rep.codes.ORIG_FINGERPRINT_MISMATCH === 'error' && errFp, noCandidate: stored.versions === 0 && !rep.canActivate,
			ackCannotWaive: act.status === 400 && !L.q1(data, 'SELECT count(*) AS n FROM work.active').n, notServed: served === 404, alive: await alive(s),
		}, { out, mismatchCodes: rep.codes, activationStatus: act.status, served });
	});

	await S('S37', "'constructor', '__proto__' and 'toString' as doc_type/bundle values tally as numbers in the overview; the overview page renders", async () => {
		const data = join(sub('s37'), 'data');
		const s = await pool.up(data, { name: 's37' });
		const cs = await mk('c37', { caseDir: c1.caseDir, edit: (r) => { const ch = r.DATA.chronology; ch[0].doc_type = 'constructor'; ch[1].doc_type = '__proto__'; ch[2].bundle = 'toString'; ch[3].bundle = '__proto__'; ch[4].doc_type = 'hasOwnProperty'; } });
		const imp = await s.c.importPkg(cs.caseDir, cs.pkgDir);
		const ov = JSON.parse(L.q1(data, 'SELECT overview FROM version WHERE id = ?', cs.resultsVersion)?.overview ?? 'null');
		const found = [];
		const walk = (o, p) => { if (!o || typeof o !== 'object') return; for (const k of Object.keys(o)) { if (['constructor', '__proto__', 'toString', 'hasOwnProperty'].includes(k)) found.push({ path: `${p}.${k}`, value: o[k] }); walk(o[k], `${p}.${k}`); } };
		walk(ov?.counts, 'counts');
		const page = await s.c.get(`${L.vp(cs.resultsVersion)}/overview`);
		return verdict({ stored: /^\/import\/\d+$/.test(imp.location ?? ''), keysFound: found.length >= 4, allNumbers: found.every((f) => typeof f.value === 'number' && f.value >= 1), page200: page.status === 200 }, { found });
	});

	await S('S38', "a manifest resultsVersion of '.', '..', 'sha256:../..' or a well-formed wrong digest is rejected; / reaches a page in fewer than 10 redirects", async () => {
		const base = sub('s38');
		const data = join(base, 'data');
		const s = await pool.up(data, { name: 's38' });
		const out = {};
		for (const [k, rv] of [['dot', '.'], ['dotdot', '..'], ['traversal', 'sha256:../..'], ['wrongDigest', 'sha256:' + 'ab'.repeat(32)]]) {
			const pk = await pkgFrom(join(base, `pkg-${k}`), editManifestOnly(c1.files, (m) => { m.resultsVersion = rv; }));
			const imp = await s.c.importPkg(c1.caseDir, pk);
			const rep = await s.c.report(imp.importId);
			out[k] = { verdict: rep.verdict, errors: Object.entries(rep.codes).filter(([, v]) => v === 'error').map(([c]) => c) };
		}
		const hops = await L.rootHops(s);
		return verdict({ allRejected: Object.values(out).every((r) => r.verdict === 'reject' && r.errors.length > 0), nothingStored: L.q1(data, MAIN_COUNT_SQL).versions === 0, rootTerminates: hops.hops < 10 && hops.status === 200 }, { out, hops });
	});

	await S('S41', 'an identical re-import still validates its inputs: another folder -> APP_CASE_FOLDER_DIFFERS, a missing folder -> APP_INPUT_INVALID, edited dataset bytes under the same manifest -> PKG_FILE_HASH_MISMATCH (never a silent no-op); the same inputs -> ?noop=1', async () => {
		const base = sub('s41');
		const data = join(base, 'data');
		const s = await pool.up(data, { name: 's41' });
		const first = await s.c.importPkg(c1.caseDir, c1.pkgDir);
		const other = copyCase('s41');
		const edited = join(base, 'pkg-edited');
		cpSync(c1.pkgDir, edited, { recursive: true });
		const f = join(edited, 'datasets', 'chronology.json');
		writeFileSync(f, readFileSync(f, 'utf8').replace('Synthetic subject OD-001', 'Synthetic subject OD-00X'));
		const out = {};
		for (const [k, cf, pk] of [['otherFolder', other, c1.pkgDir], ['missingFolder', join(base, 'nope'), c1.pkgDir], ['editedDataset', c1.caseDir, edited], ['same', c1.caseDir, c1.pkgDir]]) {
			const imp = await s.c.importPkg(cf, pk);
			const rep = imp.noop ? null : await s.c.report(imp.importId);
			out[k] = { noop: imp.noop, location: imp.location, verdict: rep?.verdict, appCodes: rep?.appCodes, errors: rep ? Object.entries(rep.codes).filter(([, v]) => v === 'error').map(([c]) => c) : null };
		}
		return verdict({
			firstStored: /^\/import\/\d+$/.test(first.location ?? ''), otherFolder: !out.otherFolder.noop && out.otherFolder.verdict === 'reject' && out.otherFolder.appCodes.includes('APP_CASE_FOLDER_DIFFERS'),
			missingFolder: !out.missingFolder.noop && out.missingFolder.appCodes.includes('APP_INPUT_INVALID'),
			editedDataset: !out.editedDataset.noop && out.editedDataset.verdict === 'reject' && out.editedDataset.errors.includes('PKG_FILE_HASH_MISMATCH'), same: out.same.noop,
		}, out);
	});

	await S('S42', 'backwards wall clock (LD_PRELOAD clock shift of -1 h, proved by the stored timestamps): retention keeps the just-imported candidate and the just-written backup', async () => {
		const base = sub('s42');
		const so = join(base, 'clockshift.so');
		const cc = L.compileShim(join(import.meta.dirname, 'clockshift.c'), so);
		if (!cc.ok) return { pass: false, evidence: { reason: `cannot build the LD_PRELOAD clock shim: ${cc.reason}; no faketime fallback is wired` } };
		const shift = join(base, 'shift');
		writeFileSync(shift, '0');
		const data = join(base, 'data');
		const s = await pool.up(data, { name: 's42', env: { LD_PRELOAD: so, CLOCK_SHIFT_FILE: shift, CLEARCASE_KEEP_CANDIDATES: '1', CLEARCASE_KEEP_BACKUPS: '2' } });
		const a = await ctx.importActivate(s, c1);
		const c4 = ctx.c4 ?? (ctx.c4 = await mk('c4i', { caseDir: c1.caseDir, edit: (r) => { r.DATA.chronology[1].subject = 'Synthetic subject OD-002 (third conversion)'; } }));
		const i4 = await s.c.importPkg(c1.caseDir, c4.pkgDir); // candidate at real time
		writeFileSync(shift, '-3600');
		const i2 = await s.c.importPkg(c1.caseDir, c2.pkgDir); // candidate one hour "earlier"
		const at = Object.fromEntries(L.q(data, 'SELECT id, at FROM import_attempt').map((r) => [r.id, r.at]));
		const versions = L.q(data, 'SELECT id FROM version').map((r) => r.id);
		const act = await s.c.activate(i2.importId, { ack: false });
		const backups = L.backupsIn(data);
		const newest = backups.at(-1) && L.readBackup(join(data, 'backups', backups.at(-1)));
		writeFileSync(shift, '0');
		const shiftedMs = Date.parse(at[i4.importId]) - Date.parse(at[i2.importId]);
		return verdict({
			shimActive: shiftedMs > 3000 * 1000, activated: a.ok, justImportedKept: versions.includes(c2.resultsVersion), olderTimestampPruned: !versions.includes(c4.resultsVersion),
			activatedJustImported: act.status === 303, keptTwoBackups: backups.length === 2, newestBackupIsJustWritten: newest?.active?.[0]?.version_id === c2.resultsVersion,
		}, { compiler: cc.cc, importAt: at, shiftedMs, versions, backups });
	});

	// ---------------------------------------------------------------- GRS-10 bounds with sparse files
	const GB9 = 9 * L.GiB, GB7 = 7 * L.GiB;
	await S('LIMIT-ORIGINAL', '>8 GiB original: declared -> ASSET_TOO_LARGE, on disk -> ORIG_TOO_LARGE; rejected before hashing (rchar/read_bytes delta and time), nothing stored', async () => {
		const base = sub('limit-orig');
		const cd = copyCase('limit-orig');
		mkdirSync(join(cd, 'BIG'), { recursive: true });
		writeFileSync(join(cd, 'BIG', 'BG-009 huge.bin'), 'placeholder bytes');
		const cs = await mk('limit-orig', { caseDir: cd, rows: [row('BG-009', 9, 'BIG/BG-009 huge.bin', 17)] });
		const declared = await pkgFrom(join(base, 'pkg-declared'), editPackage(cs.files, 'assets.json', (v) => { v.assets['BG-009'].size = GB9; }));
		L.sparse(join(cd, 'BIG', 'BG-009 huge.bin'), GB9);
		const data = join(base, 'data');
		const s = await pool.up(data, { name: 'limit-orig' });
		const out = {};
		for (const [k, pk] of [['declared', declared], ['onDisk', cs.pkgDir]]) {
			const io0 = L.procIo(s.pid);
			const imp = await s.c.importPkg(cd, pk);
			const io1 = L.procIo(s.pid);
			const rep = await s.c.report(imp.importId);
			out[k] = { verdict: rep.verdict, codes: rep.codes, rcharDelta: io1.rchar - io0.rchar, readBytesDelta: io1.read_bytes - io0.read_bytes, ms: Math.round(imp.ms) };
		}
		const unread = (r) => r.rcharDelta < 64 * L.MiB && r.ms < 10000;
		return verdict({ declaredRejected: out.declared.verdict === 'reject' && out.declared.codes.ASSET_TOO_LARGE === 'error', onDiskRejected: out.onDisk.verdict === 'reject' && out.onDisk.codes.ORIG_TOO_LARGE === 'error',
			declaredUnread: unread(out.declared), onDiskUnread: unread(out.onDisk), nothingStored: L.q1(data, MAIN_COUNT_SQL).versions === 0 }, out);
	});

	await S('LIMIT-TOTAL', '>32 GiB of referenced originals (5 x 7 GiB sparse, each under the per-original bound) -> ORIG_TOTAL_TOO_LARGE, rejected before hashing; nothing stored', async () => {
		const base = sub('limit-total');
		const cd = copyCase('limit-total');
		mkdirSync(join(cd, 'BIG'), { recursive: true });
		const rows = [];
		for (let i = 1; i <= 5; i++) { writeFileSync(join(cd, 'BIG', `BT-00${i} part.bin`), `placeholder ${i}`); rows.push(row(`BT-00${i}`, 20 + i, `BIG/BT-00${i} part.bin`, 13)); }
		const cs = await mk('limit-total', { caseDir: cd, rows });
		const files = editPackage(cs.files, 'assets.json', (v) => { for (let i = 1; i <= 5; i++) v.assets[`BT-00${i}`].size = GB7; });
		const pk = await pkgFrom(join(base, 'pkg-total'), files);
		for (let i = 1; i <= 5; i++) L.sparse(join(cd, 'BIG', `BT-00${i} part.bin`), GB7);
		const data = join(base, 'data');
		const s = await pool.up(data, { name: 'limit-total' });
		const io0 = L.procIo(s.pid);
		const imp = await s.c.importPkg(cd, pk);
		const io1 = L.procIo(s.pid);
		const rep = await s.c.report(imp.importId);
		const r = { verdict: rep.verdict, codes: rep.codes, rcharDelta: io1.rchar - io0.rchar, readBytesDelta: io1.read_bytes - io0.read_bytes, ms: Math.round(imp.ms) };
		return verdict({ rejected: r.verdict === 'reject' && r.codes.ORIG_TOTAL_TOO_LARGE === 'error', unread: r.rcharDelta < 64 * L.MiB && r.ms < 10000, nothingStored: L.q1(data, MAIN_COUNT_SQL).versions === 0 }, r);
	});

	await S('IMPORT-CANCEL', 'POST /import?/cancel while a 6 GiB original is being hashed -> IMPORT_ABORTED, no version, no package_file rows, the active version unchanged', async () => {
		const base = sub('cancel');
		const cd = copyCase('cancel');
		mkdirSync(join(cd, 'BIG'), { recursive: true });
		L.sparse(join(cd, 'BIG', 'BC-001 slow.bin'), 6 * L.GiB);
		const cs = await mk('cancel', { caseDir: cd, rows: [row('BC-001', 30, 'BIG/BC-001 slow.bin', 6 * L.GiB)] });
		const data = join(base, 'data');
		const s = await pool.up(data, { name: 'cancel' });
		const a = await ctx.importActivate(s, c1, { caseDir: cd });
		const before = L.tableCounts(data);
		const pending = s.c.importPkg(cd, cs.pkgDir);
		let seen = null;
		const t0 = Date.now();
		while (Date.now() - t0 < 30000) {
			const p = await fetch(`${s.c.origin}/api/import-progress`).then((r) => r.json()).catch(() => null);
			if (p?.progress?.phase === 'hash' && p.progress.bytesDone > 0) { seen = p.progress; break; }
			await L.sleep(10);
		}
		const cancel = await s.c.form('/import?/cancel', {});
		const imp = await pending;
		const rep = await s.c.report(imp.importId);
		const after = L.tableCounts(data);
		const rows = L.q1(data, 'SELECT count(*) AS n FROM package_file WHERE version_id = ?', cs.resultsVersion).n;
		return verdict({
			activated: a.ok, cancelledWhileHashing: !!seen && seen.bytesDone < seen.bytesTotal, cancelAnswered: cancel.status === 200 && /cancelled/.test(cancel.text),
			aborted: rep.verdict === 'reject' && rep.codes.IMPORT_ABORTED === 'error', noVersion: L.q1(data, 'SELECT count(*) AS n FROM version WHERE id = ?', cs.resultsVersion).n === 0, noPackageFiles: rows === 0,
			onlyAttemptRow: after.import_attempt === before.import_attempt + 1 && after.version === before.version && after.package_file === before.package_file, activeUnchanged: (await s.c.activeVersion()) === v1,
		}, { progressAtCancel: seen, cancel: cancel.text.slice(0, 200), codes: rep.codes, ms: Math.round(imp.ms) });
	});

	await S('UNRELATED-BIG', 'an unrelated 20 GiB sparse file in the case folder is never read by an import (rchar delta) and does not count towards the bounds', async () => {
		const base = sub('unrelated');
		const cd = copyCase('unrelated');
		mkdirSync(join(cd, 'UNRELATED'), { recursive: true });
		L.sparse(join(cd, 'UNRELATED', 'huge-unrelated.bin'), 20 * L.GiB);
		const data = join(base, 'data');
		const s = await pool.up(data, { name: 'unrelated' });
		const io0 = L.procIo(s.pid);
		const imp = await s.c.importPkg(cd, c1.pkgDir);
		const io1 = L.procIo(s.pid);
		const rep = await s.c.report(imp.importId);
		return verdict({ stored: /^\/import\/\d+$/.test(imp.location ?? '') && rep.verify === 'verified', unread: io1.rchar - io0.rchar < 16 * L.MiB, noLimitCode: !Object.keys(rep.codes).some((c) => /TOO_LARGE/.test(c)) },
			{ rcharDelta: io1.rchar - io0.rchar, ms: Math.round(imp.ms), codes: rep.codes });
	});

	await S('DATA-DIR', 'data directory resolution of the real server: CLEARCASE_DATA_DIR override; else $XDG_DATA_HOME/clearcase; a relative XDG_DATA_HOME is ignored (-> $HOME/.local/share/clearcase); /api/health reports the absolute directory and the stores are created there', async () => {
		const base = sub('datadir');
		const home = join(base, 'home');
		mkdirSync(home, { recursive: true });
		const xdg = join(base, 'xdg');
		const cases = [
			['override', { CLEARCASE_DATA_DIR: join(base, 'explicit'), HOME: home, XDG_DATA_HOME: xdg }, join(base, 'explicit')],
			['xdg', { CLEARCASE_DATA_DIR: '', HOME: home, XDG_DATA_HOME: xdg }, join(xdg, 'clearcase')],
			['relativeXdg', { CLEARCASE_DATA_DIR: '', HOME: home, XDG_DATA_HOME: 'relative/xdg' }, join(home, '.local', 'share', 'clearcase')],
			['home', { CLEARCASE_DATA_DIR: '', HOME: home, XDG_DATA_HOME: '' }, join(home, '.local', 'share', 'clearcase')],
		];
		const out = {};
		for (const [k, env, want] of cases) {
			const s = await pool.up(want, { name: `datadir-${k}`, env });
			const h = await s.c.health();
			out[k] = { reported: h.instance.dataDir, want, stores: existsSync(join(want, 'results.sqlite')) && existsSync(join(want, 'work.sqlite')) };
			await s.stop('SIGTERM');
			if (k !== 'home') rmSync(want, { recursive: true, force: true });
		}
		const relativeLeak = existsSync(join(ctx.ROOT, 'relative'));
		return verdict({ ...Object.fromEntries(Object.entries(out).map(([k, r]) => [k, r.reported === r.want && r.stores])), noRelativeDirInAppRoot: !relativeLeak }, out);
	});
}
