// Serve-time integrity of originals through the real originals listener: S23, S30, S31, S33, S40, S56, large
// originals (mutation during the snapshot, parallel exact download, serve-tmp empty while streaming, latency) and a
// case folder replaced at the same path (410 until the same package is imported again, which rebinds it).
// Every scenario works on its own COPY of the case folder; the shared synthetic folder is never modified.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { row } from '../lib/fixtures.ts';

const here = import.meta.dirname;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

export default async function originalsScenarios(ctx) {
	const { S, verdict, pool, sub, mk, L, c1, c2, T, meta } = ctx;
	const v1 = c1.resultsVersion, v2 = c2.resultsVersion;
	const OD1 = 'DISCOVERY A/OD-001 Supply agreement.pdf', OD2 = 'DISCOVERY A/OD-002 Invoice 1001.pdf';
	const copyCase = (name) => { const d = join(sub(name), 'case'); cpSync(c1.caseDir, d, { recursive: true }); return d; };
	const o = (s, rv, key, name = 'x', headers) => s.o.get(`/o/${rv}/${key}/${encodeURIComponent(name)}`, { headers });
	const bytesOf = (caseDir, rel) => readFileSync(join(caseDir, ...rel.split('/')));
	const reasonOf = (r) => (r.body ? r.body.toString('utf8').slice(0, 120) : null);

	await S('S23', 'originals are found only via (resultsVersion, key): name ignored, unknown/traversal 404, IP Host 421, cross-site needs the link capability, candidates servable, missing-at-import 410, retention prunes never-activated candidates (404) and keeps activated ones', async () => {
		const cd = copyCase('s23');
		const data = join(sub('s23'), 'data');
		const s = await pool.up(data, { name: 's23' });
		const a = await ctx.importActivate(s, c1, { caseDir: cd });
		const want = bytesOf(cd, OD1);
		const named = await o(s, v1, 'OD-001', 'anything-at-all.exe');
		const bare = await s.o.get(`/o/${v1}/OD-001`);
		const enc = await s.o.get(`/o/${encodeURIComponent(v1)}/OD-001/x`);
		const trav = await s.o.get(`/o/${v1}/OD-001/../../../../etc/passwd`);
		const unknownKey = await o(s, v1, 'ZZ-999');
		const unknownVer = await o(s, 'sha256:' + '0'.repeat(64), 'OD-001');
		const ipHost = await new Promise((res) => http.get({ host: '127.0.0.1', port: s.ports.origPort, path: `/o/${v1}/OD-001/x`, agent: false }, (r) => { r.resume(); res(r.statusCode); }).on('error', (e) => res(String(e.code))));
		const crossNoK = await o(s, v1, 'OD-001', 'x', { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' });
		const link = await L.originalPath(s, v1, 'OD-001');
		const crossK = link ? await s.o.get(link, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' } }) : { status: null };
		const crossFrame = link ? await s.o.get(link, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' } }) : { status: null };
		const imp2 = await s.c.importPkg(cd, c2.pkgDir); // a candidate, never activated
		const cand = await o(s, v2, 'OD-001');
		// missing at import: own data dir, folder without SD-001
		const cdm = copyCase('s23-missing');
		rmSync(join(cdm, 'DISCOVERY B', 'SD-001 Statement.pdf'));
		const dm = join(sub('s23-missing'), 'data');
		const sm = await pool.up(dm, { name: 's23-missing' });
		const im = await sm.c.importPkg(cdm, c1.pkgDir);
		const rm_ = await sm.c.report(im.importId);
		const miss = await o(sm, v1, 'SD-001');
		await sm.stop('SIGTERM');
		// retention: keep 1 never-activated candidate per case
		const dr = join(sub('s23-retention'), 'data');
		const sr = await pool.up(dr, { name: 's23-retention', env: { CLEARCASE_KEEP_CANDIDATES: '1' } });
		const ra = await ctx.importActivate(sr, c1, { caseDir: cd });
		const c4 = ctx.c4 ?? (ctx.c4 = await mk('c4o', { caseDir: c1.caseDir, edit: (r) => { r.DATA.chronology[1].subject = 'Synthetic subject OD-002 (third conversion)'; } }));
		await sr.c.importPkg(cd, c2.pkgDir);
		await sr.c.importPkg(cd, c4.pkgDir);
		const versions = L.q(dr, 'SELECT id FROM version ORDER BY id').map((r) => r.id);
		const retired = L.q(dr, 'SELECT id FROM retired_version').map((r) => r.id);
		const after = { v1: (await o(sr, v1, 'OD-001')).status, v2: (await o(sr, v2, 'OD-001')).status, c4: (await o(sr, c4.resultsVersion, 'OD-001')).status };
		return verdict({
			activated: a.ok, nameIgnored: named.status === 200 && named.body.equals(want), bareKey: bare.status === 200 && bare.body.equals(want), encodedColon: enc.status === 200,
			traversal404: trav.status === 404, unknownKey404: unknownKey.status === 404, unknownVersion404: unknownVer.status === 404, ipHost421: ipHost === 421,
			crossSiteWithoutK403: crossNoK.status === 403, crossSiteWithK200: crossK.status === 200 && crossK.body.equals(want), crossSiteFrame403: crossFrame.status === 403,
			candidateServable: /^\/import\/\d+$/.test(imp2.location ?? '') && cand.status === 200,
			missingAtImportWarned: rm_.codes.ORIG_MISSING === 'warning', missing410: miss.status === 410 && /missing at import/.test(reasonOf(miss) ?? ''),
			retentionActivatedKept: ra.ok && after.v1 === 200 && versions.includes(v1), retentionPruned: retired.includes(v2) && !versions.includes(v2) && after.v2 === 404,
			newestCandidateKept: after.c4 === 200,
		}, { statuses: { named: named.status, bare: bare.status, enc: enc.status, trav: trav.status, unknownKey: unknownKey.status, unknownVer: unknownVer.status, ipHost, crossNoK: crossNoK.status, crossK: crossK.status, crossFrame: crossFrame.status, cand: cand.status, miss: miss.status }, missReason: reasonOf(miss), missingCodes: rm_.codes, versions, retired, after });
	});

	await S('S30', 'same-size in-place edit of an original -> 410 on the buffered and the snapshot path (never the changed bytes); activation of a version whose original changed is refused and succeeds once restored; a re-pointed case-folder symlink never serves the new tree', async () => {
		const cd = copyCase('s30');
		const data = join(sub('s30'), 'data');
		let s = await pool.up(data, { name: 's30' });
		const a = await ctx.importActivate(s, c1, { caseDir: cd });
		const f = join(cd, ...OD1.split('/'));
		const orig = readFileSync(f);
		const ok0 = await o(s, v1, 'OD-001');
		const old = L.patchInPlace(f, 12, Buffer.from('XYZ'));
		const buffered = await o(s, v1, 'OD-001');
		L.patchInPlace(f, 12, old);
		const bufferedRestored = await o(s, v1, 'OD-001');
		const ports = s.ports;
		await s.stop('SIGTERM');
		s = await pool.up(data, { name: 's30-snapshot', ports, env: { CLEARCASE_BUFFER_MAX_BYTES: '8' } });
		L.patchInPlace(f, 12, Buffer.from('XYZ'));
		const snap = await o(s, v1, 'OD-001');
		L.patchInPlace(f, 12, old);
		const snapRestored = await o(s, v1, 'OD-001');
		// a replaced inode with different bytes of the same size
		writeFileSync(f + '.new', Buffer.from(orig).fill(0x41, 10, 20));
		renameSync(f + '.new', f);
		const replaced = await o(s, v1, 'OD-001');
		writeFileSync(f, orig);
		// activation of a candidate whose original changed after import
		const imp = await s.c.importPkg(cd, c2.pkgDir);
		const f2 = join(cd, ...OD2.split('/'));
		const old2 = L.patchInPlace(f2, 12, Buffer.from('QQ'));
		const reportWhileChanged = (await s.c.report(imp.importId)).verify;
		const refused = await s.c.activate(imp.importId);
		const activeAfterRefusal = await s.c.activeVersion();
		L.patchInPlace(f2, 12, old2);
		const accepted = await s.c.activate(imp.importId, { ack: false });
		// a case folder imported through a symlink that is later re-pointed to another tree: the recorded realpath wins
		const other = join(sub('s30-other'), 'case');
		cpSync(cd, other, { recursive: true });
		L.patchInPlace(join(other, ...OD1.split('/')), 12, Buffer.from('OTH'));
		const link = join(sub('s30-link'), 'caselink');
		symlinkSync(cd, link);
		const dl = join(sub('s30-link'), 'data');
		const sl = await pool.up(dl, { name: 's30-link' });
		await sl.c.importPkg(link, c1.pkgDir);
		rmSync(link); symlinkSync(other, link);
		const viaLink = await o(sl, v1, 'OD-001');
		const storedRoot = L.q1(dl, 'SELECT case_folder, case_root FROM version WHERE id = ?', v1);
		await sl.stop('SIGTERM');
		const serveTmp = L.dirList(join(data, 'serve-tmp'));
		return verdict({
			repointedSymlinkServesImportedTree: viaLink.status === 200 && viaLink.body.equals(orig) && storedRoot.case_root === cd,
			activated: a.ok, before200: ok0.status === 200 && ok0.body.equals(orig), buffered410: buffered.status === 410 && /changed since import/.test(reasonOf(buffered) ?? ''),
			bufferedRestored200: bufferedRestored.status === 200 && bufferedRestored.body.equals(orig), snapshot410: snap.status === 410 && /changed since import/.test(reasonOf(snap) ?? ''),
			snapshotRestored200: snapRestored.status === 200 && snapRestored.body.equals(orig), replacedInode410: replaced.status === 410,
			activationRefused: refused.status === 409 && /revalidating|no longer matches/.test(refused.error ?? ''), pointerUnchanged: activeAfterRefusal === v1,
			activationAfterRestore: accepted.status === 303 && (await s.c.activeVersion()) === v2, serveTmpEmpty: serveTmp.length === 0,
		}, { buffered: reasonOf(buffered), snapshot: reasonOf(snap), replaced: reasonOf(replaced), refused: refused.error, accepted: accepted.error ?? accepted.location, serveTmp, reportVerifyStateWhileChanged: reportWhileChanged, storedRoot, note: 'the report verify state refers to the stored package copy; it is recorded, not asserted' });
	});

	await S('S31', 'an original flipping between a regular file and a symlink to an outside file (atomic renames) is never read through: the outside bytes are never served or stored, no 500, on the buffered and the snapshot path and during imports; a package file flipping the same way during 40 imports is never read through either', async () => {
		const base = sub('s31');
		const cd = copyCase('s31');
		const secretFile = join(base, 'outside-secret.pdf');
		const target = join(cd, ...OD1.split('/'));
		const orig = readFileSync(target);
		const secret = Buffer.from(orig.toString('latin1').replace(/agreement/, 'SECRET!!!'), 'latin1');
		writeFileSync(secretFile, secret);
		const regular = join(base, 'regular-copy.pdf');
		writeFileSync(regular, orig);
		const results = {};
		for (const [label, env] of [['buffered', {}], ['snapshot', { CLEARCASE_BUFFER_MAX_BYTES: '8' }]]) {
			const data = join(base, `data-${label}`);
			const s = await pool.up(data, { name: `s31-${label}`, env });
			const imp = await s.c.importPkg(cd, c1.pkgDir);
			const sw = spawn(process.execPath, [join(here, 'swapper.mjs'), target, regular, secretFile], { stdio: ['ignore', 'pipe', 'inherit'] });
			let swOut = ''; sw.stdout.on('data', (d) => (swOut += d));
			const tally = { 200: 0, 410: 0, other: {} , secret: 0, wrong200: 0 };
			const until = Date.now() + 2500;
			await Promise.all(Array.from({ length: 8 }, async () => {
				while (Date.now() < until) {
					const r = await o(s, v1, 'OD-001');
					if (r.body?.equals(secret)) tally.secret++;
					if (r.status === 200) { tally[200]++; if (!r.body.equals(orig)) tally.wrong200++; } else if (r.status === 410) tally[410]++; else tally.other[r.status] = (tally.other[r.status] ?? 0) + 1;
				}
			}));
			// an import while the swap runs (fresh data dir state: the same version is stored -> identical path hashes again)
			const imports = [];
			for (let i = 0; i < 6; i++) { const r = await s.c.importPkg(cd, c1.pkgDir); imports.push(r.location ?? r.status); }
			sw.kill('SIGTERM');
			await new Promise((r) => sw.once('exit', r));
			const storedSecret = L.q(data, 'SELECT count(*) AS n FROM package_file WHERE instr(bytes, ?) > 0', Buffer.from('SECRET!!!')).at(0).n;
			const after = await o(s, v1, 'OD-001');
			results[label] = { stored: /^\/import\/\d+$/.test(imp.location ?? ''), tally, flips: (() => { try { return JSON.parse(swOut.trim().split('\n').at(-1)).flips; } catch { return null; } })(), imports, storedSecret, after: after.status, alive: (await s.c.health()).instance?.pid === s.pid };
			await s.stop('SIGTERM');
		}
		// a PACKAGE file flipping to an outside symlink during 40 imports (prototype S31 first half)
		{
			const data = join(base, 'data-package');
			const s = await pool.up(data, { name: 's31-package' });
			const pk = join(base, 'pkg-flip');
			cpSync(c1.pkgDir, pk, { recursive: true });
			const mt = join(pk, 'datasets', 'matter.json');
			const regularMatter = join(base, 'matter-regular.json');
			cpSync(mt, regularMatter);
			const outside = join(base, 'outside-matter.json');
			writeFileSync(outside, readFileSync(mt, 'utf8').replace('Synthetic matter', 'OUTSIDE-MARKER'));
			const sw = spawn(process.execPath, [join(here, 'swapper.mjs'), mt, regularMatter, outside], { stdio: ['ignore', 'pipe', 'inherit'] });
			let swOut = ''; sw.stdout.on('data', (d) => (swOut += d));
			const tally = {};
			for (let i = 0; i < 40; i++) {
				const r = await s.c.importPkg(cd, pk);
				const k = r.status !== 303 ? `http-${r.status}` : r.noop ? 'noop' : (await s.c.report(r.importId)).verdict;
				tally[k] = (tally[k] ?? 0) + 1;
			}
			sw.kill('SIGTERM');
			await new Promise((r) => sw.once('exit', r));
			const marker = L.q(data, 'SELECT count(*) AS n FROM package_file WHERE instr(bytes, ?) > 0', Buffer.from('OUTSIDE-MARKER')).at(0).n;
			const docs = L.q(data, "SELECT count(*) AS n FROM version WHERE overview LIKE '%OUTSIDE-MARKER%'").at(0).n;
			results.packageFile = { tally, flips: (() => { try { return JSON.parse(swOut.trim().split('\n').at(-1)).flips; } catch { return null; } })(), markerInPackageFile: marker, markerInReadModel: docs, alive: (await s.c.health()).instance?.pid === s.pid };
			await s.stop('SIGTERM');
		}
		// the snapshot path admits 2 concurrent large snapshots and answers 503 + Retry-After beyond that (documented)
		const ok = (r, allowed) => r.stored && r.tally.secret === 0 && r.tally.wrong200 === 0 && Object.keys(r.tally.other).every((k) => allowed.includes(k)) && r.flips > 100 && r.tally[410] > 0 && r.storedSecret === 0 && r.after === 200 && r.alive && r.imports.every((x) => typeof x === 'string' && x.startsWith('/import/'));
		const pf = results.packageFile;
		return verdict({ buffered: ok(results.buffered, []), snapshot: ok(results.snapshot, ['503']), packageFileNeverReadThrough: pf.markerInPackageFile === 0 && pf.markerInReadModel === 0 && !Object.keys(pf.tally).some((k) => k.startsWith('http-')) && pf.flips > 100 && pf.alive }, results);
	});

	await S('S33', 'a hard-linked original (link made after import) answers 410 "other hard links"; removing the link serves it again', async () => {
		const base = sub('s33');
		const cd = copyCase('s33');
		const data = join(base, 'data');
		const s = await pool.up(data, { name: 's33' });
		const imp = await s.c.importPkg(cd, c1.pkgDir);
		const before = await o(s, v1, 'OD-002');
		linkSync(join(cd, ...OD2.split('/')), join(base, 'second-name.pdf'));
		const linked = await o(s, v1, 'OD-002');
		rmSync(join(base, 'second-name.pdf'));
		const after = await o(s, v1, 'OD-002');
		// a hard link present already at import time: the import verdict is recorded, serving is refused
		const cd2 = copyCase('s33-at-import');
		linkSync(join(cd2, ...OD2.split('/')), join(base, 'second-name-2.pdf'));
		const d2 = join(base, 'data2');
		const s2 = await pool.up(d2, { name: 's33-at-import' });
		const imp2 = await s2.c.importPkg(cd2, c1.pkgDir);
		const rep2 = await s2.c.report(imp2.importId);
		const linked2 = await o(s2, v1, 'OD-002');
		return verdict({ stored: /^\/import\/\d+$/.test(imp.location ?? ''), before200: before.status === 200, linked410: linked.status === 410 && /hard links/.test(reasonOf(linked) ?? ''), unlinked200: after.status === 200,
			atImportNever200: linked2.status === 410 },
		{ linked: reasonOf(linked), atImport: { verdict: rep2.verdict, codes: rep2.codes, serve: linked2.status, reason: reasonOf(linked2) } });
	});

	await S('S40', 'a procfs file as an original (case folder /proc/<pid>, original environ declared with its real digest) is never verified, stored or served', async () => {
		const base = sub('s40');
		const data = join(base, 'data');
		const s = await pool.up(data, { name: 's40' });
		const envBytes = readFileSync(`/proc/${s.pid}/environ`);
		// build the package against a plain folder holding a copy of the server's environ, then import against /proc/<pid>
		const fake = join(base, 'fakeproc');
		mkdirSync(fake, { recursive: true });
		cpSync(c1.caseDir, fake, { recursive: true });
		writeFileSync(join(fake, 'environ'), envBytes);
		const cp = await mk('c40', { caseDir: fake, rows: [row('PX-001', 40, 'environ', envBytes.length)] });
		const imp = await s.c.importPkg(`/proc/${s.pid}`, cp.pkgDir);
		const rep = await s.c.report(imp.importId);
		const stored = L.q(data, 'SELECT count(*) AS n FROM version').at(0).n;
		const serve = await o(s, cp.resultsVersion, 'PX-001');
		return verdict({ rejected: rep.verdict === 'reject', mismatchError: rep.codes.ORIG_FINGERPRINT_MISMATCH === 'error' || rep.codes.ORIG_UNREADABLE === 'error' || Object.entries(rep.codes).some(([k, v]) => /^ORIG_/.test(k) && v === 'error'), nothingStored: stored === 0, notServed: serve.status === 404, alive: (await s.c.health()).instance?.pid === s.pid },
			{ codes: rep.codes, appCodes: rep.appCodes, serve: serve.status, environBytes: envBytes.length });
	});

	// ---------------------------------------------------------------- large originals
	const LG = join(T, 'cases', 'large-case');
	let large = null;
	const sizesMiB = (process.env.E2E_LATENCY_SIZES_MIB ?? '1,8,32,64,256').split(',').map(Number);
	const buildLarge = async () => {
		if (large) return large;
		cpSync(c1.caseDir, LG, { recursive: true });
		mkdirSync(join(LG, 'LARGE'), { recursive: true });
		mkdirSync(join(LG, 'LAT'), { recursive: true });
		const sha1 = L.randomFile(join(LG, 'LARGE', 'LG-001 mutate.bin'), 64 * L.MiB);
		const sha2 = L.randomFile(join(LG, 'LARGE', 'LG-002 steady.bin'), 48 * L.MiB);
		L.randomFile(join(LG, 'LARGE', 'LG-003 abort.bin'), 40 * L.MiB);
		const rows = [row('LG-001', 50, 'LARGE/LG-001 mutate.bin', 64 * L.MiB), row('LG-002', 51, 'LARGE/LG-002 steady.bin', 48 * L.MiB), row('LG-003', 52, 'LARGE/LG-003 abort.bin', 40 * L.MiB)];
		sizesMiB.forEach((m, i) => { L.sparse(join(LG, 'LAT', `LT-00${i + 1} ${m}m.bin`), m * L.MiB); rows.push(row(`LT-00${i + 1}`, 60 + i, `LAT/LT-00${i + 1} ${m}m.bin`, m * L.MiB)); });
		const cs = await mk('large', { caseDir: LG, rows });
		large = { cs, sha1, sha2, sha3: L.sha(readFileSync(join(LG, 'LARGE', 'LG-003 abort.bin'))) };
		return large;
	};
	const largeServer = async (name, env = {}) => {
		const { cs } = await buildLarge();
		const data = join(sub(name), 'data');
		const s = await pool.up(data, { name, env });
		const a = await ctx.importActivate(s, cs, { caseDir: LG });
		if (!a.ok) throw new Error(`large case activation failed: ${JSON.stringify(a)}`);
		return { s, data, rv: cs.resultsVersion };
	};

	await S('LARGE-MUTATE', 'a >32 MiB original mutated in place while the server snapshots it -> 410, never 200 with other bytes; a parallel unmodified large download gets exactly the right bytes; serve-tmp empty afterwards (default 32 MiB threshold)', async () => {
		const { s, data, rv } = await largeServer('large-mutate');
		const f = join(LG, 'LARGE', 'LG-001 mutate.bin');
		const offset = 60 * L.MiB, len = 4096;
		const trials = [];
		for (let i = 0; i < 4; i++) {
			const saved = Buffer.from(readFileSync(f).subarray(offset, offset + len));
			const m = spawn(process.execPath, [join(here, 'mutator.mjs'), join(data, 'serve-tmp'), f, String(offset), String(len), String(4 * L.MiB), '20000'], { stdio: ['ignore', 'pipe', 'inherit'] });
			let out = '';
			await new Promise((res) => m.stdout.on('data', (d) => { out += d; if (out.includes('ready')) res(); }));
			const [a, b] = await Promise.all([o(s, rv, 'LG-001', 'x', {}).then((r) => ({ ...r, body: null, okBytes: r.sha256 === large.sha1 })), s.o.get(`/o/${rv}/LG-002/x`, { keep: false })]);
			await new Promise((r) => (m.exitCode !== null ? r() : m.once('exit', r)));
			const mut = (() => { try { return JSON.parse(out.trim().split('\n').at(-1)); } catch { return { raw: out }; } })();
			L.patchInPlace(f, offset, saved);
			trials.push({ mutated: { status: a.status, size: a.size, rightBytes: a.okBytes }, parallel: { status: b.status, exact: b.sha256 === large.sha2 && b.size === 48 * L.MiB, ms: r1(b.totalMs) }, mutator: mut });
		}
		const restored = await s.o.get(`/o/${rv}/LG-001/x`, { keep: false });
		const serveTmp = L.dirList(join(data, 'serve-tmp'));
		return verdict({
			everyMutatedTrialPatchedMidSnapshot: trials.every((t) => t.mutator.patched === true),
			mutated410: trials.every((t) => t.mutated.status === 410), neverWrong200: trials.every((t) => t.mutated.status !== 200 || t.mutated.rightBytes),
			parallelExact: trials.every((t) => t.parallel.status === 200 && t.parallel.exact), restored200: restored.status === 200 && restored.sha256 === large.sha1, serveTmpEmpty: serveTmp.length === 0,
		}, { trials, restored: restored.status, serveTmp });
	});

	await S('LARGE-STREAM', 'a large original streams from a verified snapshot whose name is already unlinked: serve-tmp is empty while the download is in progress and the bytes are exact', async () => {
		const { s, data, rv } = await largeServer('large-stream');
		const r = await new Promise((resolve) => {
			const req = http.request({ host: '127.0.0.1', port: s.ports.origPort, path: `/o/${rv}/LG-002/x`, headers: { host: s.o.host }, agent: false }, (res) => {
				const h = createHash('sha256');
				let size = 0, during = null;
				res.once('data', (c) => {
					size += c.length; h.update(c);
					res.pause();
					setTimeout(() => { during = L.dirList(join(data, 'serve-tmp')); res.on('data', (c2) => { size += c2.length; h.update(c2); }); res.resume(); }, 300);
				});
				res.on('end', () => resolve({ status: res.statusCode, size, sha256: h.digest('hex'), during }));
			});
			req.on('error', (e) => resolve({ error: String(e.code ?? e) }));
			req.end();
		});
		return verdict({ status200: r.status === 200, serveTmpEmptyDuringStream: Array.isArray(r.during) && r.during.length === 0, exact: r.sha256 === large.sha2 && r.size === 48 * L.MiB, emptyAfter: L.dirList(join(data, 'serve-tmp')).length === 0 }, r);
	});

	await S('S56', 'aborted downloads (20 aborts each of a 40 MiB original on the snapshot path and, with a 48 MiB threshold, on the buffered path) never crash or leak descriptors or snapshots; a full download afterwards is exact', async () => {
		const res = {};
		for (const [label, env, key, sha] of [['snapshot', {}, 'LG-003', () => large.sha3], ['buffered', { CLEARCASE_BUFFER_MAX_BYTES: String(48 * L.MiB) }, 'LG-003', () => large.sha3]]) {
			const { s, data, rv } = await largeServer(`s56-${label}`, env);
			await s.o.get(`/o/${rv}/${key}/x`, { keep: false }); // warm-up
			await L.sleep(200);
			const fd0 = L.fdCount(s.pid);
			const aborts = [];
			for (let i = 0; i < 20; i++) aborts.push(await s.o.abortAfterFirstChunk(`/o/${rv}/${key}/x`));
			await L.sleep(800);
			const fd1 = L.fdCount(s.pid);
			const full = await s.o.get(`/o/${rv}/${key}/x`, { keep: false });
			res[label] = { fd0, fd1, aborted: aborts.filter((a) => a.aborted).length, statuses: [...new Set(aborts.map((a) => a.status))], full: { status: full.status, exact: full.sha256 === sha() }, serveTmp: L.dirList(join(data, 'serve-tmp')), alive: (await s.c.health()).instance?.pid === s.pid };
			await s.stop('SIGTERM');
		}
		const ok = (r) => r.aborted === 20 && r.statuses.length === 1 && r.statuses[0] === 200 && r.fd1 <= r.fd0 + 3 && r.full.status === 200 && r.full.exact && r.serveTmp.length === 0 && r.alive;
		return verdict({ snapshot: ok(res.snapshot), buffered: ok(res.buffered) }, res);
	});

	await S('LARGE-LATENCY', `serve latency (TTFB and total, median of 3) for ${sizesMiB.join(', ')} MiB originals at the default 32 MiB threshold; every response exact`, async () => {
		const { s, rv } = await largeServer('large-latency');
		const rows = [];
		for (const [i, m] of sizesMiB.entries()) {
			const runs = [];
			for (let k = 0; k < 3; k++) runs.push(await s.o.get(`/o/${rv}/LT-00${i + 1}/x`, { keep: false }));
			rows.push({ MiB: m, path: m * L.MiB <= 32 * L.MiB ? 'buffered' : 'snapshot', ttfbMs: r1(median(runs.map((r) => r.ttfbMs))), totalMs: r1(median(runs.map((r) => r.totalMs))), allExact: runs.every((r) => r.status === 200 && r.size === m * L.MiB && r.sha256 === L.zeroSha(m * L.MiB)) });
		}
		meta.measurements.originalsLatency = rows;
		return verdict({ allExact: rows.every((r) => r.allExact) }, { rows });
	});

	await S('CASE-REPLACED', 'case folder replaced at the same path (new inode, same bytes): originals 410 and activation refused until the same package is imported again, which rebinds the version (then 200 and activation succeeds)', async () => {
		const base = sub('case-replaced');
		const cd = copyCase('case-replaced');
		const data = join(base, 'data');
		const s = await pool.up(data, { name: 'case-replaced' });
		const a = await ctx.importActivate(s, c1, { caseDir: cd });
		const imp2 = await s.c.importPkg(cd, c2.pkgDir);
		const before = await o(s, v1, 'OD-001');
		const ino0 = L.q1(data, 'SELECT case_dev, case_ino FROM version WHERE id = ?', v1);
		renameSync(cd, cd + '.old');
		cpSync(cd + '.old', cd, { recursive: true });
		rmSync(cd + '.old', { recursive: true, force: true });
		const gone = await o(s, v1, 'OD-001');
		const refused = await s.c.activate(imp2.importId, { ack: false });
		const re1 = await s.c.importPkg(cd, c1.pkgDir);
		const ino1 = L.q1(data, 'SELECT case_dev, case_ino FROM version WHERE id = ?', v1);
		const back = await o(s, v1, 'OD-001');
		const stillRefusedV2 = await s.c.activate(imp2.importId, { ack: false });
		const re2 = await s.c.importPkg(cd, c2.pkgDir);
		const accepted = await s.c.activate(imp2.importId, { ack: false });
		return verdict({
			activated: a.ok, before200: before.status === 200, replaced410: gone.status === 410 && /replaced/.test(reasonOf(gone) ?? ''),
			activationRefused: refused.status === 409 && /missing, or was moved or replaced/.test(refused.error ?? ''),
			reimportNoopRebinds: re1.noop && ino1.case_ino !== ino0.case_ino, served200AfterRebind: back.status === 200,
			otherVersionStillRefused: stillRefusedV2.status === 409, rebindOther: re2.noop, activationAfterRebind: accepted.status === 303 && (await s.c.activeVersion()) === v2,
		}, { gone: reasonOf(gone), refused: refused.error, ino0, ino1, re1: re1.location, re2: re2.location, accepted: accepted.error ?? accepted.location });
	});
}
