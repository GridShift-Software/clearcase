// Store durability and recovery scenarios: S22, S43-S49 (and S43b), S51-S55, S59, S61 (each in its own data directory).
import { copyFileSync, cpSync, rmSync, statSync, truncateSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { editManifestOnly } from '../../../case-package/fixtures/build.ts';
import { writePackageDir } from '../../../../src/lib/case-package/writer.ts';

export default async function storeScenarios(ctx) {
	const { S, verdict, pool, sub, mk, L, c1, c2 } = ctx;
	const v1 = c1.resultsVersion, v2 = c2.resultsVersion;
	const c4 = await mk('c4', { caseDir: c1.caseDir, edit: (r) => { r.DATA.chronology[1].subject = 'Synthetic subject OD-002 (third conversion)'; } });
	/** v1 activated (acknowledged), optionally v2 activated on top (carry-forward). */
	const baseline = async (s, { withV2 = false } = {}) => {
		const a = await ctx.importActivate(s, c1);
		const b = withV2 ? await ctx.importActivate(s, c2) : null;
		if (!a.ok || (withV2 && !b.ok)) throw new Error(`baseline activation failed: ${JSON.stringify({ a: a.act, b: b?.act })}`);
		return { a, b };
	};
	const drop = (d, vid) => {
		for (const t of ['document', 'asset', 'seed', 'package_file']) d.prepare(`DELETE FROM ${t} WHERE version_id = ?`).run(vid);
		d.prepare('DELETE FROM version WHERE id = ?').run(vid);
	};
	const banner = (html) => /id="recovery-banner"/.test(html);

	await S('S22', 'startup recovery: lost/corrupt active version -> newest verified activation with banner, adopt rewrites the pointer; dangling pointer; no fallback; garbage results.sqlite -> 503 + storageError; startup never crashes', async () => {
		const base = sub('s22');
		const tpl = join(base, 'template');
		let s = await pool.up(tpl, { name: 's22-template' });
		await baseline(s, { withV2: true });
		const note = 'S22 recovery note on OD-001';
		const n = await L.noteAdd(s, v2, 'OD-001', note);
		const before = await s.c.activeVersion();
		await s.stop('SIGTERM');
		const out = { before, noteAcked: n.ok };
		for (const mode of ['lost', 'corrupt-row', 'corrupt-blob', 'dangling-pointer', 'no-fallback', 'unusable']) {
			const dir = join(base, mode);
			cpSync(tpl, dir, { recursive: true });
			if (mode === 'unusable') { for (const f of ['results.sqlite', 'results.sqlite-wal', 'results.sqlite-shm']) rmSync(join(dir, f), { force: true }); writeFileSync(join(dir, 'results.sqlite'), Buffer.alloc(8192, 0x5a)); }
			else L.withDb(dir, (d) => {
				if (mode === 'lost') drop(d, v2);
				else if (mode === 'no-fallback') { drop(d, v2); drop(d, v1); }
				else if (mode === 'dangling-pointer') d.prepare('UPDATE work.active SET version_id = ?').run('sha256:' + '0'.repeat(64));
				else if (mode === 'corrupt-row') d.prepare("UPDATE document SET row_json = substr(row_json, 1, 40) WHERE version_id = ? AND ref = 'OD-001'").run(v2);
				else d.prepare("UPDATE package_file SET bytes = zeroblob(size) WHERE version_id = ? AND path = 'datasets/chronology.json'").run(v2);
			});
			const r = { mode };
			try {
				s = await pool.up(dir, { name: `s22-${mode}` });
				r.started = true;
				const root = await s.c.get('/');
				r.root = { status: root.status, location: root.location, text: root.status === 503 ? root.text.slice(0, 120) : undefined };
				r.home = await s.c.home();
				const h = await fetch(`${s.c.origin}/api/health`);
				const hj = await h.json();
				r.health = { status: h.status, storageError: hj.storageError?.slice(0, 120) ?? null, recovery: hj.recovery };
				if (mode === 'unusable') {
					r.originals = (await s.o.get(`/o/${v2}/OD-001/x`)).status;
				} else if (mode === 'no-fallback') {
					const imp = await s.c.get('/import');
					r.importPage = { status: imp.status, banner: banner(imp.text), adopt: /id="recovery-adopt"/.test(imp.text), noFallbackText: /No earlier activation verifies/.test(imp.text) };
					const re = await ctx.importActivate(s, c1);
					const ov = await s.c.get(`${L.vp(v1)}/overview`);
					r.afterReimport = { activated: re.ok, active: await s.c.activeVersion(), banner: banner(ov.text) };
				} else if (mode === 'dangling-pointer') {
					const ov = await s.c.get(`${L.vp(v2)}/overview`);
					r.overview = { status: ov.status, banner: banner(ov.text), adopt: /id="recovery-adopt"/.test(ov.text) };
					r.note = (await L.notesOn(s, v2, 'OD-001')).notes.some((x) => x.body === note);
				} else {
					const ov = await s.c.get(`${L.vp(v1)}/overview`);
					r.overview = { status: ov.status, banner: banner(ov.text), adopt: /id="recovery-adopt"/.test(ov.text) };
					r.brokenVersionPage = (await s.c.get(`${L.vp(v2)}/overview`)).status;
					r.brokenDocPage = (await s.c.get(`${L.vp(v2)}/doc/OD-001`)).status;
					r.note = (await L.notesOn(s, v1, 'OD-001')).notes.some((x) => x.body === note);
					const adopt = await s.c.form('/recovery?/adopt', { case: 'e2e-case' });
					r.adopt = { status: adopt.status, location: adopt.location };
					r.lastLogKind = L.q1(dir, 'SELECT kind, version_id FROM work.activation_log ORDER BY id DESC LIMIT 1');
					await s.stop('SIGTERM');
					s = await pool.up(dir, { name: `s22-${mode}-restart` });
					const ov2 = await s.c.get(`${L.vp(v1)}/overview`);
					r.afterAdoptRestart = { active: await s.c.activeVersion(), banner: banner(ov2.text) };
				}
				const stop = await s.stop('SIGTERM');
				r.stoppedCleanly = stop.graceful && stop.exit?.code === 0;
			} catch (e) { r.started = false; r.error = String(e?.stack ?? e).slice(0, 600); }
			out[mode] = r;
		}
		const fellBack = (r, brokenStatus) => r.started && r.root.status === 307 && r.root.location === '/cases' && r.home === `${L.vp(v1)}/overview` && r.overview.status === 200 && r.overview.banner && r.overview.adopt &&
			r.brokenVersionPage === brokenStatus && r.brokenDocPage === brokenStatus && r.note && r.health.recovery?.configured === v2 && r.health.recovery?.effective === v1 &&
			r.adopt.status === 303 && r.adopt.location === `${L.vp(v1)}/overview` && r.lastLogKind?.kind === 'recovery' && r.lastLogKind?.version_id === v1 &&
			r.afterAdoptRestart.active === v1 && !r.afterAdoptRestart.banner && r.stoppedCleanly;
		const dp = out['dangling-pointer'], nf = out['no-fallback'], u = out.unusable;
		return verdict({
			templateActiveV2: out.before === v2 && out.noteAcked,
			lost: fellBack(out.lost, 404), corruptRow: fellBack(out['corrupt-row'], 409), corruptBlob: fellBack(out['corrupt-blob'], 409),
			danglingShowsLoggedV2: dp.started && dp.home === `${L.vp(v2)}/overview` && dp.overview.status === 200 && dp.overview.banner && dp.note && dp.stoppedCleanly,
			noFallback: nf.started && nf.root.status === 307 && nf.root.location === '/cases' && nf.home === null && nf.importPage.banner && !nf.importPage.adopt && nf.importPage.noFallbackText &&
				nf.afterReimport.activated && nf.afterReimport.active === v1 && !nf.afterReimport.banner && nf.stoppedCleanly,
			unusable: u.started && u.root.status === 503 && u.health.status === 200 && !!u.health.storageError && u.originals === 503 && u.stoppedCleanly,
		}, out);
	});

	await S('S43', 'a second instance on the same data directory exits at once without pruning, sweeping or writing (same ports and other ports)', async () => {
		const data = join(sub('s43'), 'data');
		const s = await pool.up(data, { name: 's43-A' });
		await baseline(s);
		await s.c.importPkg(c1.caseDir, c2.pkgDir);
		await s.c.importPkg(c1.caseDir, c4.pkgDir);
		const tmp = join(data, 'backups', `.tmp-${s.pid}-work-inflight-by-A.sqlite`);
		writeFileSync(tmp, 'A is writing this backup');
		mkdirSync(join(data, 'serve-tmp'), { recursive: true });
		const snap = join(data, 'serve-tmp', `${s.pid}-0123456789abcdef`);
		writeFileSync(snap, 'A is snapshotting');
		const state = () => ({ versions: L.q(data, 'SELECT id FROM version ORDER BY id').map((r) => r.id), counts: L.tableCounts(data), backups: L.backupsIn(data) });
		const before = state();
		const env = { CLEARCASE_KEEP_CANDIDATES: '1' }; // B would prune A's two candidates if it ran its startup
		const same = await pool.spawnExpectExit(data, { ports: s.ports, env, name: 's43-B-same' });
		const other = await pool.spawnExpectExit(data, { env, name: 's43-B-other' });
		const after = state();
		const h = await s.c.health();
		const cut = (b) => ({ exitedOnItsOwn: b.exitedOnItsOwn, exit: b.exit, message: b.log.split('\n').filter((l) => /another ClearCase process|FATAL/.test(l)).slice(0, 2).map((l) => l.slice(0, 240)) });
		return verdict({
			sameExits: same.exitedOnItsOwn && same.exit.code !== 0 && same.exit.ms < 5000, otherExits: other.exitedOnItsOwn && other.exit.code !== 0 && other.exit.ms < 5000,
			namesTheOtherProcess: /another ClearCase process/.test(same.log) && /another ClearCase process/.test(other.log),
			nothingWritten: JSON.stringify(before) === JSON.stringify(after), tempBackupKept: L.exists(tmp), snapshotKept: L.exists(snap),
			aStillServes: (await s.c.get('/')).status === 307 && h.instance.pid === s.pid,
		}, { same: cut(same), other: cut(other), before: before.counts });
	});

	await S('S43b', 'instance.lock unlinked under a running instance: a second instance is still refused, and a refused instance leaves link-key alone (PRFIX-6b)', async () => {
		const data = join(sub('s43b'), 'data');
		const s = await pool.up(data, { name: 's43b-A' });
		await baseline(s);
		const key = join(data, 'link-key');
		const keyBefore = statSync(key);
		rmSync(join(data, 'instance.lock'));
		const b = await pool.spawnExpectExit(data, { name: 's43b-B' });
		const keyAfter = statSync(key);
		rmSync(key);
		const b2 = await pool.spawnExpectExit(data, { name: 's43b-B2' });
		const h = await s.c.health();
		const cut = (x) => ({ exitedOnItsOwn: x.exitedOnItsOwn, exit: x.exit, message: x.log.split('\n').filter((l) => /FATAL|listening/.test(l)).slice(0, 2).map((l) => l.slice(0, 240)) });
		return verdict({
			bRefused: b.exitedOnItsOwn && b.exit.code !== 0 && /another ClearCase process/.test(b.log) && !/app listening/.test(b.log),
			b2Refused: b2.exitedOnItsOwn && b2.exit.code !== 0 && /another ClearCase process/.test(b2.log),
			linkKeyCtimeKept: keyAfter.ctimeMs === keyBefore.ctimeMs, missingLinkKeyNotRecreated: !L.exists(key),
			aStillServes: (await s.c.get('/')).status === 307 && h.instance.pid === s.pid,
		}, { b: cut(b), b2: cut(b2) });
	});

	await S('S44', 'store files removed while running: writes answer 503 and are never acknowledged; a restart with work.sqlite missing shows the work-missing banner', async () => {
		const base = sub('s44');
		const data = join(base, 'data');
		let s = await pool.up(data, { name: 's44-a' });
		await baseline(s);
		for (const f of ['work.sqlite', 'work.sqlite-journal', 'work.sqlite-wal', 'work.sqlite-shm']) rmSync(join(data, f), { force: true });
		const note = await L.noteAdd(s, v1, 'OD-001', 'note after work.sqlite was removed');
		const root = await s.c.get('/');
		const ports = s.ports;
		await s.stop('SIGTERM');
		s = await pool.up(data, { name: 's44-a-restart', ports });
		const imp = await s.c.get('/import');
		const storedNote = L.q(data, "SELECT count(*) AS n FROM work.note WHERE body = 'note after work.sqlite was removed'")[0].n;
		await s.stop('SIGTERM');
		const d2 = join(base, 'data2');
		s = await pool.up(d2, { name: 's44-b' });
		await baseline(s);
		rmSync(d2, { recursive: true, force: true });
		const note2 = await L.noteAdd(s, v1, 'OD-001', 'note after rm -rf of the data dir');
		const root2 = await s.c.get('/');
		const h2 = await s.c.health();
		return verdict({
			workRemovedNote503: !note.ok && note.status === 503, workRemovedRoot503: root.status === 503 && /removed while ClearCase was running/.test(root.text),
			restartWarning: /id="warning-work-missing"/.test(imp.text), noteNeverStored: storedNote === 0,
			dataDirRemovedNote503: !note2.ok && note2.status === 503, dataDirRemovedRoot503: root2.status === 503, healthReportsIt: !!h2.storageError,
		}, { note, root: root.text.slice(0, 200), note2, root2: root2.status, storageError: h2.storageError });
	});

	await S('S45', 'a damaged stored version (active, and the previous one) is repaired by re-importing the same package (?repaired=1) and survives restart', async () => {
		const data = join(sub('s45'), 'data');
		let s = await pool.up(data, { name: 's45' });
		await baseline(s, { withV2: true });
		const ports = s.ports;
		await s.stop('SIGTERM');
		L.withDb(data, (d) => {
			d.prepare("UPDATE document SET row_json = substr(row_json, 1, 40) WHERE version_id = ? AND ref = 'OD-001'").run(v2);
			d.prepare("DELETE FROM package_file WHERE version_id = ? AND path = 'datasets/matter.json'").run(v1);
		});
		s = await pool.up(data, { name: 's45-damaged', ports });
		const v2p = await s.c.get(`${L.vp(v2)}/overview`);
		const before = { home: await s.c.home(), v2: v2p.status, advice: /Import the same package again/.test(v2p.text), v1: (await s.c.get(`${L.vp(v1)}/overview`)).status };
		const r2 = await s.c.importPkg(c1.caseDir, c2.pkgDir);
		const r1 = await s.c.importPkg(c1.caseDir, c1.pkgDir);
		const ov = await s.c.get(`${L.vp(v2)}/overview`);
		const after = { v2: ov.status, v1: (await s.c.get(`${L.vp(v1)}/overview`)).status, active: await s.c.activeVersion(), banner: banner(ov.text) };
		await s.stop('SIGTERM');
		s = await pool.up(data, { name: 's45-restart', ports });
		const ov3 = await s.c.get(`${L.vp(v2)}/overview`);
		const restart = { active: await s.c.activeVersion(), banner: banner(ov3.text), status: ov3.status };
		return verdict({
			damaged409: before.v2 === 409 && before.v1 === 409 && before.advice, repairedBoth: r2.repaired && r1.repaired,
			afterRepair: after.v2 === 200 && after.v1 === 200 && after.active === v2 && !after.banner, afterRestart: restart.active === v2 && !restart.banner && restart.status === 200,
		}, { before, r2: r2.location, r1: r1.location, after, restart });
	});

	await S('S46', 'no work.sqlite-wal after SIGKILL: a restored backup shows exactly the backup state (no hybrid); a garbage work.sqlite -> 503 that names the sidecars', async () => {
		const data = join(sub('s46'), 'data');
		let s = await pool.up(data, { name: 's46', env: { CLEARCASE_USERWORK_BACKUP_DELAY_MS: '60000' } });
		await baseline(s);
		const n = await L.noteAdd(s, v1, 'OD-002', 'S46 note written after the last backup');
		const ports = s.ports;
		await s.stop('SIGKILL');
		const sidecars = L.dirList(data).filter((f) => /^work\.sqlite-/.test(f));
		const newest = L.backupsIn(data).at(-1);
		copyFileSync(join(data, 'backups', newest), join(data, 'work.sqlite'));
		s = await pool.up(data, { name: 's46-restored', ports });
		const h = await s.c.health();
		const visible = (await L.notesOn(s, v1, 'OD-002')).notes.some((x) => x.body.startsWith('S46 note'));
		const active = await s.c.activeVersion();
		await s.stop('SIGTERM');
		writeFileSync(join(data, 'work.sqlite'), Buffer.alloc(8192, 0x5a));
		s = await pool.up(data, { name: 's46-garbage', ports });
		const r = await s.c.get('/');
		return verdict({
			noteAcked: n.ok, noWorkWal: !sidecars.includes('work.sqlite-wal'), restoredClean: !h.storageError && active === v1, noHybrid: !visible,
			garbage503: r.status === 503, namesSidecars: /work\.sqlite-journal/.test(r.text) && /sidecar/.test(r.text),
		}, { sidecarsAfterKill: sidecars, restoredFrom: newest, storageError: h.storageError, text: r.text.slice(0, 600) });
	});

	await S('S47', 'startup while another process holds the results write lock: no permanent storage error; pages work once the lock is released', async () => {
		const data = join(sub('s47'), 'data');
		let s = await pool.up(data, { name: 's47' });
		await baseline(s);
		await s.c.importPkg(c1.caseDir, c2.pkgDir);
		await s.c.importPkg(c1.caseDir, c4.pkgDir);
		const ports = s.ports;
		await s.stop('SIGTERM');
		const lock = new DatabaseSync(join(data, 'results.sqlite'));
		lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
		const t0 = Date.now();
		const release = L.sleep(7000).then(() => { lock.exec('ROLLBACK'); lock.close(); return Date.now() - t0; });
		s = await pool.up(data, { name: 's47-locked', ports, env: { CLEARCASE_KEEP_CANDIDATES: '1' }, timeoutMs: 60000 });
		const heldMs = await release;
		const statuses = [];
		for (let i = 0; i < 20; i++) { statuses.push((await s.c.get('/')).status); if (statuses.at(-1) === 307) break; await L.sleep(500); }
		const h = await s.c.health();
		return verdict({ pagesWorkAfterRelease: statuses.at(-1) === 307, noStorageError: !h.storageError, neverHttp500: !statuses.includes(500) },
			{ heldMs, startupMs: Math.round(s.readyMs), statuses, pruneError: h.startup?.pruneError, pruned: h.startup?.pruned });
	});

	await S('S48', 'an active pointer edited to another existing version shows the recovery banner and the version the activation log names', async () => {
		const data = join(sub('s48'), 'data');
		let s = await pool.up(data, { name: 's48' });
		await baseline(s, { withV2: true });
		const ports = s.ports;
		await s.stop('SIGTERM');
		L.withDb(data, (d) => d.prepare('UPDATE work.active SET version_id = ?').run(v1));
		s = await pool.up(data, { name: 's48-edited', ports });
		const root = await s.c.home();
		const page = await s.c.get(root ?? '/cases');
		return verdict({ showsLoggedV2: root === `${L.vp(v2)}/overview`, banner: banner(page.text), reason: /differs from the activation log/.test(page.text) }, { root });
	});

	await S('S49', 'a changed byte in a stored note body is marked data-note-integrity=mismatch', async () => {
		const data = join(sub('s49'), 'data');
		let s = await pool.up(data, { name: 's49' });
		await baseline(s);
		const n = await L.noteAdd(s, v1, 'OD-001', 'S49 note alpha');
		const ports = s.ports;
		await s.stop('SIGTERM');
		L.withDb(data, (d) => d.prepare("UPDATE work.note SET body = replace(body, 'alpha', 'alphA')").run());
		s = await pool.up(data, { name: 's49-altered', ports });
		const t = (await s.c.get(`${L.vp(v1)}/doc/OD-001`)).text;
		return verdict({ noteAcked: n.ok, shown: /S49 note alphA/.test(t), marked: /data-note-integrity="mismatch"/.test(t) });
	});

	await S('S51', 'a row changed on disk by another connection is re-verified on the next request (409), not served from the cache', async () => {
		const data = join(sub('s51'), 'data');
		const s = await pool.up(data, { name: 's51' });
		await baseline(s);
		const s0 = (await s.c.get(`${L.vp(v1)}/doc/OD-001`)).status;
		L.withDb(data, (d) => d.prepare("UPDATE document SET row_json = replace(row_json, 'Synthetic subject OD-001', '[TAMPERED]') WHERE version_id = ? AND ref = 'OD-001'").run(v1));
		const r = await s.c.get(`${L.vp(v1)}/doc/OD-001`);
		const chron = await s.c.get(`/api/v/${encodeURIComponent(v1)}/chronology`);
		return verdict({ before200: s0 === 200, after409: r.status === 409, notShown: !r.text.includes('[TAMPERED]'), chronologyJson409: chron.status === 409 }, { before: s0, after: r.status, chronology: chron.status });
	});

	await S('S52', 'user work is backed up a moment after a note write and at graceful stop', async () => {
		const data = join(sub('s52'), 'data');
		const s = await pool.up(data, { name: 's52', env: { CLEARCASE_USERWORK_BACKUP_DELAY_MS: '500' } });
		await baseline(s);
		const n1 = await L.noteAdd(s, v1, 'OD-001', 'S52 debounced note');
		await L.sleep(1500);
		const after1 = L.readBackup(join(data, 'backups', L.backupsIn(data).at(-1)));
		const n2 = await L.noteAdd(s, v1, 'OD-002', 'S52 note right before stop');
		const stop = await s.stop('SIGTERM');
		const newest = L.backupsIn(data).at(-1);
		const after2 = L.readBackup(join(data, 'backups', newest));
		return verdict({ acked: n1.ok && n2.ok, debouncedBackup: after1.notes.includes('S52 debounced note'), stopBackup: after2.notes.includes('S52 note right before stop'), graceful: stop.graceful && stop.exit?.code === 0, stopBackupLabel: /user-work/.test(newest) },
			{ newestAfterDebounce: after1.notes, newestAfterStop: after2.notes, newest });
	});

	await S('S53', 'truncating every -wal after a SIGKILL loses no acknowledged activation, note or import', async () => {
		const data = join(sub('s53'), 'data');
		let s = await pool.up(data, { name: 's53' });
		await baseline(s, { withV2: true });
		const n = await L.noteAdd(s, v2, 'OD-001', 'S53 note before SIGKILL');
		const imp = await s.c.importPkg(c1.caseDir, c4.pkgDir);
		const ports = s.ports;
		await s.stop('SIGKILL');
		const wals = Object.fromEntries(L.dirList(data).filter((f) => /-wal$/.test(f)).map((f) => [f, L.size(join(data, f))]));
		for (const f of Object.keys(wals)) truncateSync(join(data, f), 0);
		s = await pool.up(data, { name: 's53-truncated', ports });
		const out = { active: await s.c.activeVersion(), note: (await L.notesOn(s, v2, 'OD-001')).notes.some((x) => x.body === 'S53 note before SIGKILL'), candidate: (await s.c.get(`${L.vp(c4.resultsVersion)}/overview`)).status };
		return verdict({ acked: n.ok && /^\/import\/\d+$/.test(imp.location ?? ''), activationKept: out.active === v2, noteKept: out.note, importKept: out.candidate === 200, noWorkWal: !('work.sqlite-wal' in wals) },
			{ walSizesBeforeTruncation: wals, ...out });
	});

	await S('S54', "a write under another process's lock waits and retries and never answers 500; acknowledged <=> stored", async () => {
		const data = join(sub('s54'), 'data');
		const s = await pool.up(data, { name: 's54' });
		await baseline(s);
		const hold = async (ms, body) => {
			const lock = new DatabaseSync(join(data, 'work.sqlite'));
			lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
			const t0 = Date.now();
			const pending = L.noteAdd(s, v1, 'OD-001', body);
			await L.sleep(ms);
			lock.exec('ROLLBACK'); lock.close();
			const r = await pending;
			const stored = L.q(data, 'SELECT count(*) AS n FROM work.note WHERE body = ?', body)[0].n;
			return { ...r, ms: Date.now() - t0, stored };
		};
		const short = await hold(7000, 'S54 note under a 7 s lock');
		const long = await hold(14000, 'S54 note under a 14 s lock');
		const consistent = (r) => r.status !== 500 && (r.ok ? r.stored === 1 : r.stored === 0);
		return verdict({ shortNever500: consistent(short), shortSucceeded: short.ok, longNever500: consistent(long), long503RetryAfter: long.status === 503 && !!long.retryAfter && long.stored === 0, serverAlive: (await s.c.get('/')).status === 307 },
			{ short, long });
	});

	await S('S55', 'backups/ removed while running is recreated at the next backup; with backups/ unusable the change stands and a backup-failed banner shows', async () => {
		const data = join(sub('s55'), 'data');
		const s = await pool.up(data, { name: 's55' });
		await baseline(s);
		rmSync(join(data, 'backups'), { recursive: true, force: true });
		const a2 = await ctx.importActivate(s, c2);
		const recreated = L.backupsIn(data);
		rmSync(join(data, 'backups'), { recursive: true, force: true });
		writeFileSync(join(data, 'backups'), 'not a directory');
		const rb = await s.c.form(`${L.vp(v2)}/overview?/rollback`, { expect: v2, to: v1 });
		const page = await s.c.get(`${L.vp(v1)}/overview`);
		rmSync(join(data, 'backups'), { force: true });
		return verdict({ activated: a2.ok, recreatedWithOneBackup: recreated.length === 1, rollbackStands: rb.status === 303 && (await s.c.activeVersion()) === v1, banner: /id="warning-backup-failed"/.test(page.text) },
			{ recreated, rollback: { status: rb.status, location: rb.location } });
	});

	await S('S59', '10 concurrent activations of one candidate: one activation_log row, one backup, pointer = candidate', async () => {
		const data = join(sub('s59'), 'data');
		const s = await pool.up(data, { name: 's59' });
		await baseline(s);
		const imp = await s.c.importPkg(c1.caseDir, c2.pkgDir);
		const rep = await s.c.report(imp.importId);
		const res = await Promise.all(Array.from({ length: 10 }, () => s.c.form(`/import/${imp.importId}?/activate`, rep.hidden)));
		const rows = L.q(data, 'SELECT count(*) AS n FROM work.activation_log WHERE version_id = ?', v2)[0].n;
		const backups = L.backupsIn(data).filter((f) => f.includes(`activate-${v2.slice(7, 19)}`));
		return verdict({ allRedirect: res.every((r) => r.status === 303 && r.location === `${L.vp(v2)}/overview`), oneLogRow: rows === 1, oneBackup: backups.length === 1, pointer: (await s.c.activeVersion()) === v2 },
			{ statuses: res.map((r) => r.location ?? r.status), rows, backups });
	});

	await S('S61', 'chronology JSON is revalidated (private, no-cache + read-model ETag, 304); a retired version id with a different manifest is rejected APP_VERSION_RETIRED; the same package may come back', async () => {
		const base = sub('s61');
		const data = join(base, 'data');
		const s = await pool.up(data, { name: 's61', env: { CLEARCASE_KEEP_CANDIDATES: '1' } });
		const ia = await s.c.importPkg(c1.caseDir, c1.pkgDir);
		const rm = L.q1(data, 'SELECT read_model_sha256 AS r FROM version WHERE id = ?', v1)?.r;
		const url = `/api/v/${encodeURIComponent(v1)}/chronology`;
		const r1 = await s.c.get(url);
		const r304 = await s.c.get(url, { headers: { 'if-none-match': r1.headers.etag ?? '' } });
		await s.c.importPkg(c1.caseDir, c2.pkgDir); // retention (keep 1) retires the never-activated v1
		const retired = L.q1(data, 'SELECT id, manifest_sha256 FROM retired_version WHERE id = ?', v1);
		const prunedPage = (await s.c.get(`${L.vp(v1)}/overview`)).status;
		const other = join(base, 'pkg-other-manifest');
		await writePackageDir(other, editManifestOnly(c1.files, (m) => { m.created = '2001-05-06T07:10'; }));
		const i2 = await s.c.importPkg(c1.caseDir, other);
		const rep2 = await s.c.report(i2.importId);
		const i3 = await s.c.importPkg(c1.caseDir, c1.pkgDir);
		const r3 = await s.c.get(url);
		return verdict({
			imported: /^\/import\/\d+$/.test(ia.location ?? ''), status200: r1.status === 200, revalidate: r1.headers['cache-control'] === 'private, no-cache',
			etagIsReadModel: r1.headers.etag === `"${rm}"`, conditional304: r304.status === 304, retired: !!retired && prunedPage === 404,
			retiredRejected: rep2.verdict === 'reject' && rep2.appCodes.includes('APP_VERSION_RETIRED'), sameComesBack: /^\/import\/\d+$/.test(i3.location ?? '') && !i3.noop && r3.status === 200,
			sameContent: r3.text === r1.text && r3.headers.etag === r1.headers.etag,
		}, { cacheControl: r1.headers['cache-control'], etag: r1.headers.etag, conditional: r304.status, prunedPage, retiredAppCodes: rep2.appCodes, back: i3.location });
	});
}
