#!/usr/bin/env bun
// Offline DURABILITY and SERVE-TIME INTEGRITY suite of the local pilot (GRS-12), run by `bun run --bun test:e2e`:
//   unshare -rn env OUTER_UID=$(id -u) OUTER_GID=$(id -g) tests/e2e/pilot/offline.sh bun tests/e2e/pilot/durability.mjs
// Every scenario drives the production entry (scripts/pilot/start.ts under Bun) on its own ports (43300-43597) and
// data directory, with synthetic cases built by GRS-10's real converter, and inspects the stores with node:sqlite.
// Strict: an exception is a FAIL, nothing is skipped; the run exits 0 only when every scenario passes.
// Env: E2E_ROOT (app tree, default the worktree), E2E_BUILD_DIR (default <E2E_ROOT>/build), CLEARCASE_E2E_OUT
// (results dir), CLEARCASE_E2E_TMP (parent of the per-run temp root, default <worktree>/.local/tmp; disk-backed on
// purpose: large originals and sparse files), E2E_ONLY=S9,S10 (development subset; such a run is marked partial),
// E2E_LATENCY_SIZES_MIB (default 1,8,32,64,256).
// Ported from the hardened prototype (spikes/pilot-hardened/app/tests/suite.mjs S9-S23, regress.mjs S30-S61); the
// mapping from prototype predicates to these scenarios is recorded in the results JSON (meta.prototypeMapping).
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildCase, row } from './lib/fixtures.ts';
import { proveOffline } from './lib/netproof.mjs';
import { recorder } from './lib/record.mjs';
import { bunIdentity } from './lib/server.mjs';
import { importCandidate } from '../../../src/lib/case-package/index.ts';
import { editManifestOnly } from '../../case-package/fixtures/build.ts';
import { writePackageDir } from '../../../src/lib/case-package/writer.ts';
import * as L from './durability/lib.mjs';
import { MAPPING, SUPERSEDED } from './durability/mapping.mjs';
import importScenarios from './durability/import.mjs';
import originalsScenarios from './durability/originals.mjs';
import storeScenarios from './durability/store.mjs';
import policyScenarios from './durability/policy.mjs';

const here = import.meta.dirname;
const WORKTREE = resolve(here, '..', '..', '..');
const ROOT = resolve(process.env.E2E_ROOT ?? WORKTREE);
const BUILD = resolve(process.env.E2E_BUILD_DIR ?? join(ROOT, 'build'));
const ONLY = process.env.E2E_ONLY ? new Set(process.env.E2E_ONLY.split(',').map((s) => s.trim())) : null;
const TMP_BASE = resolve(process.env.CLEARCASE_E2E_TMP ?? join(WORKTREE, '.local', 'tmp'));
mkdirSync(TMP_BASE, { recursive: true });
const T = mkdtempSync(join(TMP_BASE, 'durability-'));
let stamp = null;
try { stamp = JSON.parse(readFileSync(join(BUILD, 'clearcase-build.json'), 'utf8')); } catch (e) { stamp = { error: String(e.message) }; }
const meta = { bun: bunIdentity(), root: ROOT, buildDir: BUILD, build: stamp, tmpRoot: T, partial: ONLY ? [...ONLY] : null, prototypeMapping: MAPPING, superseded: SUPERSEDED, measurements: {} };
const R = recorder('durability', meta);
const pool = L.serverPool({ root: ROOT, buildDir: BUILD, logDir: join(T, 'logs') });

/** One scenario: fn returns { pass, evidence }; an exception is a FAIL; server log tails are kept on failure. */
async function S(id, title, fn) {
	if (ONLY && !ONLY.has(id)) return;
	pool.reset();
	const t0 = Date.now();
	let r;
	try { r = await fn(); } catch (e) { r = { pass: false, evidence: { error: String(e?.stack ?? e).slice(0, 4000) } }; }
	for (const s of [...pool.live]) await s.stop('SIGTERM').catch(() => {});
	const evidence = { ...(r?.evidence ?? {}), ms: Date.now() - t0 };
	if (!r?.pass) evidence.serverLogs = pool.tails();
	R.rec(id, title, r?.pass ? 'PASS' : 'FAIL', evidence);
}
/** Every named predicate must hold; all of them are recorded. */
export const verdict = (checks, evidence = {}) => ({ pass: Object.values(checks).every((v) => v === true), evidence: { checks, ...evidence } });
const sub = (name) => { const d = join(T, name); mkdirSync(d, { recursive: true }); return d; };
const mk = (name, opts = {}) => buildCase(join(T, 'cases', name), opts);

// ---------------------------------------------------------------- isolation proof first
const net = await proveOffline();
R.rec('NET-OFFLINE', 'the run is inside a network namespace with only lo: outbound TCP and DNS fail, loopback works', net.pass ? 'PASS' : 'FAIL', net);
if (!net.pass) { R.finish(); rmSync(T, { recursive: true, force: true }); process.exit(1); }

// ---------------------------------------------------------------- shared synthetic cases (case folder A)
const c1 = await mk('c1');
const c2 = await mk('c2', { caseDir: c1.caseDir, edit: (r) => { r.DATA.chronology[0].subject = 'Synthetic subject OD-001 (reconverted)'; } });
const ctx = { R, S, verdict, pool, T, sub, mk, L, c1, c2, ROOT, BUILD, meta };

/** Import + activate (acknowledging new warnings) through the report page. */
ctx.importActivate = async (s, cs, { ack = true, caseDir = cs.caseDir, pkgDir = cs.pkgDir } = {}) => {
	const imp = await s.c.importPkg(caseDir, pkgDir);
	const act = imp.importId ? await s.c.activate(imp.importId, { ack }) : null;
	return { imp, act, ok: !!act && act.status === 303 };
};

// ================================================================ main chain: one data directory, restarts between
const main = { dir: sub('main'), ports: L.nextPorts(), s: null };
main.data = join(main.dir, 'data');
const mainUp = async (env = {}) => { if (!main.s || main.s.exited || !pool.live.has(main.s)) main.s = await pool.up(main.data, { name: 'main', ports: main.ports, env }); return main.s; };
const st = {}; // state carried along the chain

await S('S16', 'storage pragmas: results.sqlite WAL, work.sqlite rollback journal (DELETE), synchronous=FULL on both; reported by /api/health and visible in the files', async () => {
	const s = await mainUp();
	const h = await s.c.health();
	const ff = { results: L.fileFormat(join(main.data, 'results.sqlite')), work: L.fileFormat(join(main.data, 'work.sqlite')) };
	const persisted = L.withDb(main.data, (d) => ({ results: String(Object.values(d.prepare('PRAGMA main.journal_mode').get())[0]) }));
	const files = L.dirList(main.data);
	return verdict({
		healthMainWal: h.pragmas?.main?.journal_mode === 'wal', healthMainFull: h.pragmas?.main?.synchronous === 2,
		healthWorkDelete: h.pragmas?.work?.journal_mode === 'delete', healthWorkFull: h.pragmas?.work?.synchronous === 2,
		resultsFileIsWal: ff.results.write === 2 && ff.results.read === 2, workFileIsRollback: ff.work.write === 1 && ff.work.read === 1,
		resultsPersistedWal: persisted.results === 'wal', noWorkWal: !files.includes('work.sqlite-wal'),
	}, { pragmas: h.pragmas, fileHeaderBytes18_19: ff, persisted, files });
});

await S('S17', 'package_file rows are byte-identical to the package manifest + listed files (= candidate.snapshot()); unlisted files are never stored', async () => {
	const rowsOf = async (s, data, caseDir, pk, rv) => {
		const imp = await s.c.importPkg(caseDir, pk);
		const rep = await s.c.report(imp.importId);
		const rows = L.q(data, 'SELECT path, sha256, size, bytes FROM package_file WHERE version_id = ? ORDER BY path', rv);
		const manifest = JSON.parse(readFileSync(join(pk, 'manifest.json'), 'utf8'));
		const listed = ['manifest.json', ...manifest.files.map((f) => f.path)].sort();
		const fresh = await importCandidate(pk, caseDir);
		const snap = new Map([...fresh.candidate.snapshot()].map(({ path, bytes }) => [path, bytes]));
		const diff = [];
		for (const r of rows) {
			const b = Buffer.from(r.bytes);
			if (!Buffer.from(readFileSync(join(pk, ...r.path.split('/')))).equals(b)) diff.push(`${r.path}: differs from the package file`);
			if (!snap.has(r.path) || !Buffer.from(snap.get(r.path)).equals(b)) diff.push(`${r.path}: differs from candidate.snapshot()`);
			if (r.sha256 !== L.sha(b) || r.size !== b.length) diff.push(`${r.path}: sha256/size column wrong`);
		}
		const v = L.q1(data, 'SELECT manifest_sha256 FROM version WHERE id = ?', rv);
		return { imp, rep, rows, listed, snap, diff, manifestOk: v?.manifest_sha256 === L.sha(readFileSync(join(pk, 'manifest.json'))) };
	};
	// main chain: the clean package
	const s = await mainUp();
	const a = await rowsOf(s, main.data, c1.caseDir, c1.pkgDir, c1.resultsVersion);
	st.imp1 = a.imp.importId;
	const act = await s.c.activate(a.imp.importId); // setup for the chain: c1 becomes the active version
	// own data directory: the same package plus a file the manifest does not list
	const pk = join(main.dir, 'pkg17-unlisted');
	cpSync(c1.pkgDir, pk, { recursive: true });
	writeFileSync(join(pk, 'unlisted-extra.txt'), 'present in the package folder but not listed in the manifest');
	const d2 = join(sub('s17'), 'data');
	const s2 = await pool.up(d2, { name: 's17-unlisted' });
	const b = await rowsOf(s2, d2, c1.caseDir, pk, c1.resultsVersion);
	const exact = (x) => x.rep.verify === 'verified' && JSON.stringify(x.rows.map((r) => r.path)) === JSON.stringify(x.listed) && JSON.stringify([...x.snap.keys()].sort()) === JSON.stringify(x.listed) && x.diff.length === 0 && x.manifestOk;
	return verdict({
		cleanPackageExact: exact(a), unlistedPackageExact: exact(b), unlistedNotStored: !b.rows.some((r) => r.path === 'unlisted-extra.txt'),
		// ignored files are reported as an app info line; the stored report is the stored snapshot's (no PKG_UNLISTED_FILE)
		unlistedReported: b.rep.appCodes.includes('APP_UNLISTED_IGNORED') && b.rep.codes.PKG_UNLISTED_FILE === undefined, activatedForChain: act.status === 303,
	}, { rows: a.rows.length, listed: a.listed.length, diff: [...a.diff, ...b.diff].slice(0, 10), codesUnlisted: b.rep.codes, chainActivation: act.error });
});

await S('S17b', 'a candidate whose package folder held an unlisted file (PKG_UNLISTED_FILE warning, file ignored) can be acknowledged and activated', async () => {
	const pk = join(main.dir, 'pkg17-unlisted');
	const d = join(sub('s17b'), 'data');
	const s = await pool.up(d, { name: 's17b' });
	const imp = await s.c.importPkg(c1.caseDir, pk);
	const rep = await s.c.report(imp.importId);
	const act = await s.c.activate(imp.importId);
	const stored = L.q1(d, 'SELECT overview FROM version WHERE id = ?', c1.resultsVersion);
	return verdict({ candidateStored: rep.verify === 'verified' && rep.needsAck, activated: act.status === 303, active: (await s.c.activeVersion()) === c1.resultsVersion },
		{ activateError: act.error, reasons: act.reasons, storedOverviewDiagnostics: stored && JSON.parse(stored.overview).diagnostics,
			cause: 'activation revalidates importCandidate({files: stored bytes}); the stored bytes exclude the unlisted file, so PKG_UNLISTED_FILE disappears from the fresh diagnostics and from overview.diagnostics, the fresh read-model digest differs from the stored one and diagnosticsSha256 would differ from the acknowledged one' });
});

await S('S18', 'a re-import of the same package (same resultsVersion, byte-identical manifest) is a no-op: ?noop=1 and zero rows written', async () => {
	const s = await mainUp();
	const before = L.tableCounts(main.data);
	const a = await s.c.importPkg(c1.caseDir, c1.pkgDir);
	const copy = join(main.dir, 'pkg18-copy');
	cpSync(c1.pkgDir, copy, { recursive: true });
	const b = await s.c.importPkg(c1.caseDir, copy); // a byte-identical copy in another folder
	const after = L.tableCounts(main.data);
	const page = await s.c.get(a.location);
	return verdict({ firstNoop: a.noop && a.importId === st.imp1, secondNoop: b.noop && b.importId === st.imp1, zeroRows: JSON.stringify(before) === JSON.stringify(after), noticeShown: /id="noop-msg"/.test(page.text) },
		{ a: a.location, b: b.location, before, after });
});

await S('S19', 'same resultsVersion with a different manifest is rejected APP_VERSION_CONFLICT; the stored version stays untouched', async () => {
	const s = await mainUp();
	const files = editManifestOnly(c1.files, (m) => { m.created = '2001-05-06T07:09'; m.producer = { ...m.producer, version: m.producer.version + '-other' }; });
	const pk = join(main.dir, 'pkg19');
	await writePackageDir(pk, files);
	const m = JSON.parse(Buffer.from(files.get('manifest.json')).toString());
	const snapshot = () => ({ v: L.q1(main.data, 'SELECT manifest_sha256, read_model_sha256, import_id FROM version WHERE id = ?', c1.resultsVersion), bytes: L.sha(Buffer.concat(L.q(main.data, 'SELECT bytes FROM package_file WHERE version_id = ? ORDER BY path', c1.resultsVersion).map((r) => Buffer.from(r.bytes)))) });
	const before = snapshot(), cb = L.tableCounts(main.data);
	const imp = await s.c.importPkg(c1.caseDir, pk);
	const rep = await s.c.report(imp.importId);
	const after = snapshot(), ca = L.tableCounts(main.data);
	const delta = Object.fromEntries(Object.keys(ca).filter((k) => ca[k] !== cb[k]).map((k) => [k, ca[k] - cb[k]]));
	return verdict({
		sameResultsVersion: m.resultsVersion === c1.resultsVersion, rejected: rep.verdict === 'reject', conflictCode: rep.appCodes.includes('APP_VERSION_CONFLICT'),
		storedUntouched: JSON.stringify(before) === JSON.stringify(after), onlyAttemptRow: JSON.stringify(delta) === JSON.stringify({ import_attempt: 1 }),
		activeUnchanged: (await s.c.activeVersion()) === c1.resultsVersion,
	}, { appCodes: rep.appCodes, delta });
});

await S('S20', 'one byte flipped in a stored package_file blob: activation refused, pointer unchanged, preview 409; re-import repairs it', async () => {
	const s = await mainUp();
	st.note = 'main chain note on OD-001 (c1)';
	const n = await L.noteAdd(s, c1.resultsVersion, 'OD-001', st.note);
	const imp = await s.c.importPkg(c1.caseDir, c2.pkgDir);
	st.imp2 = imp.importId;
	const logBefore = L.q1(main.data, 'SELECT count(*) AS n FROM work.activation_log').n;
	L.withDb(main.data, (d) => {
		const r = d.prepare("SELECT bytes FROM package_file WHERE version_id = ? AND path = 'datasets/matter.json'").get(c2.resultsVersion);
		const b = Buffer.from(r.bytes); b[10] ^= 0x01;
		d.prepare("UPDATE package_file SET bytes = ? WHERE version_id = ? AND path = 'datasets/matter.json'").run(b, c2.resultsVersion);
	});
	const act = await s.c.activate(imp.importId);
	const preview = await s.c.get(`${L.vp(c2.resultsVersion)}/overview`);
	const active = await s.c.activeVersion();
	const logAfter = L.q1(main.data, 'SELECT count(*) AS n FROM work.activation_log').n;
	const repair = await s.c.importPkg(c1.caseDir, c2.pkgDir);
	const previewAfter = (await s.c.get(`${L.vp(c2.resultsVersion)}/overview`)).status;
	return verdict({
		noteAcked: n.ok, refused: act.status === 409 && /failed verification|do not verify/.test(act.error ?? ''), pointerUnchanged: active === c1.resultsVersion,
		noLogRow: logAfter === logBefore, preview409: preview.status === 409, repaired: repair.repaired, previewAfterRepair200: previewAfter === 200,
	}, { activateError: act.error, previewStatus: preview.status, repair: repair.location });
});

await S('S21', 'one VACUUM INTO backup of work.sqlite per activation; the newest is consistent with the pointer and the notes', async () => {
	const s = await mainUp();
	const again = await s.c.importPkg(c1.caseDir, c2.pkgDir); // no-op: names the (repaired) import that holds c2
	st.imp2 = again.importId;
	const rep = await s.c.report(st.imp2);
	const act = await s.c.activate(st.imp2, { ack: false }); // carry-forward: c2 has exactly c1's accepted warnings
	const files = L.backupsIn(main.data);
	const activation = files.filter((f) => /-(activate|rollback|recovery)-/.test(f));
	const newest = activation.at(-1) && L.readBackup(join(main.data, 'backups', activation.at(-1)));
	const live = L.q(main.data, 'SELECT body FROM work.note ORDER BY created_at').map((r) => r.body);
	const logRows = L.q1(main.data, 'SELECT count(*) AS n FROM work.activation_log').n;
	return verdict({
		activated: act.status === 303, noAckNeeded: !rep.needsAck, oneBackupPerActivation: activation.length === logRows && logRows === 2,
		newestPointer: newest?.active?.[0]?.version_id === c2.resultsVersion, newestNotes: JSON.stringify(newest?.notes) === JSON.stringify(live),
		newestIntact: newest?.integrity === 'ok' && newest?.journal === 'delete', noTempLeft: !L.dirList(join(main.data, 'backups')).some((f) => f.startsWith('.tmp-')),
	}, { files, newest, liveNotes: live.length, logRows });
});

await S('S9', 'graceful SIGTERM: both ports closed, exit 0; restart recovers the active version and the notes', async () => {
	const s = await mainUp();
	const stop = await s.stop('SIGTERM');
	const log = s.log();
	const s2 = await mainUp();
	const active = await s2.c.activeVersion();
	const notes = await L.notesOn(s2, c2.resultsVersion, 'OD-001');
	return verdict({
		graceful: stop.graceful && stop.exit?.code === 0, portsClosed: stop.appPort !== true && stop.origPort !== true,
		shutdownLogged: /sveltekit:shutdown \(SIGTERM\)/.test(log) && /storage closed cleanly/.test(log), activeRecovered: active === c2.resultsVersion,
		noteRecovered: notes.notes.some((x) => x.body === st.note && (x.anchor === 'exact' || x.anchor === 'here')),
	}, { stop, restartMs: Math.round(s2.readyMs), active, notes: notes.notes });
});

await S('S10', 'SIGKILL at several points of an import (incl. while hashing a 4 GiB original) never leaves a partial version; integrity_check ok', async () => {
	const B = join(T, 'cases', 'c3-case');
	cpSync(c1.caseDir, B, { recursive: true });
	mkdirSync(join(B, 'BIG'), { recursive: true });
	L.sparse(join(B, 'BIG', 'BG-001 big.bin'), 4 * L.GiB);
	const c3 = await mk('c3', { caseDir: B, rows: [row('BG-001', 8, 'BIG/BG-001 big.bin', 4 * L.GiB)] });
	st.c3 = c3;
	const trials = [];
	const progress = async (s) => { try { return (await (await fetch(`${s.c.origin}/api/import-progress`)).json())?.progress ?? null; } catch { return null; } };
	for (const point of [{ afterMs: 5 }, { afterMs: 40 }, { phase: 'hash', atBytes: 1 }, { phase: 'hash', atFraction: 0.5 }, { phase: 'hash', atFraction: 0.97 }, { afterResponse: true }]) {
		const s = await mainUp();
		const t0 = performance.now();
		const pending = s.c.importPkg(B, c3.pkgDir).catch((e) => ({ error: String(e?.cause?.code ?? e?.code ?? e?.message) }));
		let seen = null;
		if (point.afterMs) await L.sleep(point.afterMs);
		else if (point.afterResponse) { seen = await pending; } // committed: kill before the checkpoint/retention work settles
		else for (;;) {
			const p = await progress(s);
			if (p && p.phase === point.phase && (point.phase !== 'hash' || p.bytesDone >= (point.atBytes ?? p.bytesTotal * point.atFraction))) { seen = p; break; }
			if (!p && seen === null && performance.now() - t0 > 2000) { seen = { finishedBeforeSeen: true }; break; }
			if (performance.now() - t0 > 60000) { seen = { timeout: true, last: p }; break; }
			await L.sleep(5);
		}
		const killedAt = Math.round(performance.now() - t0);
		await s.stop('SIGKILL');
		const res = await pending;
		const s2 = await mainUp();
		const stored = L.q1(main.data, 'SELECT count(*) AS n FROM version WHERE id = ?', c3.resultsVersion).n === 1;
		const page = stored ? (await s2.c.get(`${L.vp(c3.resultsVersion)}/overview`)).status : null;
		trials.push({ point, killedAt, progressSeen: seen, response: res.error ?? res.location ?? res.status, stored, previewStatus: page, integrity: L.integrity(main.data), active: await s2.c.activeVersion() });
	}
	const s = await mainUp();
	const fin = await s.c.importPkg(B, c3.pkgDir);
	const rows = L.q(main.data, 'SELECT path, bytes FROM package_file WHERE version_id = ? ORDER BY path', c3.resultsVersion);
	const exact = rows.length === c3.files.size && rows.every((r) => c3.files.has(r.path) && Buffer.from(c3.files.get(r.path)).equals(Buffer.from(r.bytes)));
	const notes = await L.notesOn(s, c2.resultsVersion, 'OD-001');
	return verdict({
		hashPhaseHit: trials.filter((t) => t.point.phase === 'hash').every((t) => t.progressSeen?.phase === 'hash' && t.progressSeen.bytesDone < t.progressSeen.bytesTotal),
		killedAfterCommitStored: trials.at(-1).stored === true && trials.at(-1).previewStatus === 200,
		neverPartial: trials.every((t) => !t.stored || t.previewStatus === 200), integrityOk: trials.every((t) => t.integrity.main === 'ok' && t.integrity.work === 'ok' && t.integrity.orphans === 0),
		activeUnchanged: trials.every((t) => t.active === c2.resultsVersion), finalImportStored: /^\/import\/\d+/.test(fin.location ?? ''), finalBytesExact: exact,
		finalIntegrity: (() => { const i = L.integrity(main.data); return i.main === 'ok' && i.work === 'ok' && i.orphans === 0; })(), notesKept: notes.notes.some((x) => x.body === st.note),
	}, { trials, finalImport: fin.location });
});

await S('S11', 'note writes acknowledged before a SIGKILL are all present after restart', async () => {
	const s = await mainUp();
	const token = `burst-${Date.now()}`;
	const acked = [];
	let attempted = 0, failed = 0;
	const stopAt = Date.now() + 400;
	const writer = (async () => {
		while (Date.now() < stopAt + 300) {
			const body = `${token} #${attempted++}`;
			const r = await L.noteAdd(s, c2.resultsVersion, 'OD-002', body);
			if (r.ok) acked.push(body); else { failed++; if (r.status === 0) break; }
		}
	})();
	await L.sleep(400);
	const kill = await s.stop('SIGKILL');
	await writer;
	const s2 = await mainUp();
	const present = L.q(main.data, 'SELECT body FROM work.note WHERE body LIKE ?', `${token}%`).map((r) => r.body);
	const page = await L.notesOn(s2, c2.resultsVersion, 'OD-002');
	return verdict({ someAcked: acked.length > 0, allAckedPresent: acked.every((b) => present.includes(b)), pageShowsThem: acked.every((b) => page.notes.some((n) => n.body === b)) },
		{ attempted, acked: acked.length, failedOrCut: failed, present: present.length, kill: kill.exit });
});

await S('S12', 'crash artifacts (torn results WAL tail, backups/.tmp-*, serve-tmp leftovers) are tolerated and cleaned at startup', async () => {
	const s = await mainUp();
	const rej = await s.c.importPkg(join(T, 'does-not-exist'), c1.pkgDir); // a committed write that stays in the WAL
	await s.stop('SIGKILL');
	const wal = join(main.data, 'results.sqlite-wal');
	const walBefore = L.size(wal);
	appendFileSync(wal, Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7919) & 255)));
	mkdirSync(join(main.data, 'backups'), { recursive: true });
	writeFileSync(join(main.data, 'backups', '.tmp-99999-work-0000000099-dead.sqlite'), 'half a backup');
	mkdirSync(join(main.data, 'serve-tmp'), { recursive: true });
	writeFileSync(join(main.data, 'serve-tmp', '99999-deadbeefdeadbeef'), Buffer.alloc(4096, 1));
	const sidecars = L.dirList(main.data).filter((f) => /^(results|work)\.sqlite-/.test(f));
	const s2 = await mainUp();
	const h = await s2.c.health();
	const rejPage = await s2.c.get(`/import/${rej.importId}`);
	const notes = await L.notesOn(s2, c2.resultsVersion, 'OD-001');
	const i = L.integrity(main.data);
	return verdict({
		walHadFrames: walBefore > 0, started: !h.storageError, activeIntact: (await s2.c.activeVersion()) === c2.resultsVersion, notesIntact: notes.notes.some((x) => x.body === st.note),
		committedRejectionKept: rejPage.status === 200, tmpBackupRemoved: !L.dirList(join(main.data, 'backups')).some((f) => f.startsWith('.tmp-')),
		cleanedReported: (h.startup?.cleaned ?? []).some((c) => c.includes('.tmp-99999')), serveTmpEmpty: L.dirList(join(main.data, 'serve-tmp')).length === 0,
		integrityOk: i.main === 'ok' && i.work === 'ok' && i.orphans === 0,
	}, { walBytesBeforeGarbage: walBefore, sidecarsAfterKill: sidecars, cleaned: h.startup?.cleaned, rejectedImport: rej.importId });
});

// ================================================================ independent scenarios (own data directories)
await storeScenarios(ctx);
await originalsScenarios(ctx);
await importScenarios(ctx);
await policyScenarios(ctx);

await S('S15', 'final graceful stop: exit 0, both ports closed', async () => {
	const s = await mainUp();
	const stop = await s.stop('SIGTERM');
	return verdict({ graceful: stop.graceful && stop.exit?.code === 0, portsClosed: stop.appPort !== true && stop.origPort !== true }, { stop });
});

await pool.killAll();
meta.bindRetries = { ...L.bindRetries };
const ok = R.finish();
rmSync(T, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
