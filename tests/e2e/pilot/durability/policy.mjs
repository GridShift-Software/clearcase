// User work and the activation policy through the real server: notes across activations (ref renumbering, ref
// reuse, reordering, restart, ambiguous fingerprints), acknowledgement rules (first import, carry-forward, stale and
// incomplete acknowledgements, an original removed after the page loaded), case scoping of trusted warnings, and a
// user-work table defined through UserWork.defineTable surviving restarts and backups.
import { cpSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { row } from '../lib/fixtures.ts';
import { spawnSync } from 'node:child_process';

export default async function policyScenarios(ctx) {
	const { S, verdict, pool, sub, mk, L, c1, c2 } = ctx;
	const v1 = c1.resultsVersion, v2 = c2.resultsVersion;
	const OD1 = 'DISCOVERY A/OD-001 Supply agreement.pdf';

	await S('USERWORK-ANCHORS', 'notes survive a new activation, ref renumbering (exact on the new ref), ref reuse (old note not carried), reordering and restart; a fingerprint shared by two refs is disclosed as ambiguous', async () => {
		const base = sub('uw');
		const cd = join(base, 'case');
		cpSync(c1.caseDir, cd, { recursive: true });
		cpSync(join(cd, ...OD1.split('/')), join(cd, 'DISCOVERY A', 'OD-005 Copy.pdf')); // same bytes as OD-001, unreferenced in A and B
		// B: OD-001 (agreement) renumbered to OD-011, the invoice takes the ref OD-001, rows in reverse order
		const B = await mk('uwB', { caseDir: cd, edit: (r) => { const ch = r.DATA.chronology; ch[0].ref = 'OD-011'; ch[1].ref = 'OD-001'; ch.reverse(); } });
		// C: like A plus OD-005 with the same bytes as OD-001
		const size = readFileSync(join(cd, 'DISCOVERY A', 'OD-005 Copy.pdf')).length;
		const C = await mk('uwC', { caseDir: cd, rows: [row('OD-005', 8, 'DISCOVERY A/OD-005 Copy.pdf', size)] });
		const data = join(base, 'data');
		let s = await pool.up(data, { name: 'uw' });
		const a = await ctx.importActivate(s, c1, { caseDir: cd });
		const n = { agreement: await L.noteAdd(s, v1, 'OD-001', 'UW note on the agreement'), invoice: await L.noteAdd(s, v1, 'OD-002', 'UW note on the invoice'), statement: await L.noteAdd(s, v1, 'SD-001', 'UW note on the statement') };
		const b = await ctx.importActivate(s, B, { caseDir: cd });
		const view = async (rv, ref) => (await L.notesOn(s, rv, ref)).notes.map((x) => `${x.anchor}:${x.body}`).sort();
		const inB = async () => ({ 'OD-011': await view(B.resultsVersion, 'OD-011'), 'OD-001': await view(B.resultsVersion, 'OD-001'), 'SD-001': await view(B.resultsVersion, 'SD-001'), 'OD-002': (await s.c.get(`${L.vp(B.resultsVersion)}/doc/OD-002`)).status });
		const afterB = await inB();
		const ports = s.ports;
		await s.stop('SIGTERM');
		s = await pool.up(data, { name: 'uw-restart', ports });
		const afterRestart = await inB();
		const activeAfterRestart = await s.c.activeVersion();
		const c = await ctx.importActivate(s, C, { caseDir: cd });
		const amb = { 'OD-001': (await L.notesOn(s, C.resultsVersion, 'OD-001')), 'OD-005': (await L.notesOn(s, C.resultsVersion, 'OD-005')) };
		const ambiguous = Object.fromEntries(Object.entries(amb).map(([k, p]) => [k, { notes: p.notes.map((x) => `${x.anchor}:${x.body}`), disclosesBoth: /OD-001/.test(p.html) && /OD-005/.test(p.html) }]));
		const expectB = { 'OD-011': ['exact:UW note on the agreement'], 'OD-001': ['exact:UW note on the invoice'], 'SD-001': ['exact:UW note on the statement'] };
		const okB = (x) => JSON.stringify(x['OD-011']) === JSON.stringify(expectB['OD-011']) && JSON.stringify(x['OD-001']) === JSON.stringify(expectB['OD-001']) && JSON.stringify(x['SD-001']) === JSON.stringify(expectB['SD-001']);
		return verdict({
			activations: a.ok && b.ok && c.ok, notesAcked: Object.values(n).every((r) => r.ok), renumberedExactAndReuseNotCarried: okB(afterB), oldRefGone: afterB['OD-002'] === 404,
			survivesRestart: okB(afterRestart) && activeAfterRestart === B.resultsVersion,
			ambiguousDisclosed: ['OD-001', 'OD-005'].every((k) => ambiguous[k].notes.includes('ambiguous:UW note on the agreement') && ambiguous[k].disclosesBoth),
		}, { afterB, afterRestart, ambiguous, acts: { a: a.act?.error, b: b.act?.error, c: c.act?.error } });
	});

	await S('POLICY-ACK', 'activation policy through the server: the first import needs an acknowledgement (ACK_REQUIRED), a forged/stale one is ACK_STALE, a partial one ACK_INCOMPLETE; an original removed after the page loaded refuses the old form (read model changed) and the restored folder accepts it; the same defects reordered carry forward without an acknowledgement; a new defect needs one', async () => {
		const base = sub('policy');
		const cd = join(base, 'case');
		cpSync(c1.caseDir, cd, { recursive: true });
		const R = await mk('polR', { caseDir: cd, edit: (r) => { r.DATA.chronology.reverse(); } });
		const data = join(base, 'data');
		const s = await pool.up(data, { name: 'policy' });
		const i1 = await s.c.importPkg(cd, c1.pkgDir);
		const i2 = await s.c.importPkg(cd, c2.pkgDir);
		const rep1 = await s.c.report(i1.importId);
		const rep2 = await s.c.report(i2.importId);
		const noAck = await s.c.activate(i1.importId, { ack: false });
		const stale = await s.c.activate(i1.importId, { override: [...rep1.hidden.map(([k, v]) => [k, k === 'diagnosticsSha256' ? 'f'.repeat(64) : v]), ['ack', 'on']] }); // an acknowledgement made for other diagnostics
		const fps = rep1.hidden.filter(([k]) => k === 'fp');
		const partial = await s.c.activate(i1.importId, { override: [...rep1.hidden.filter(([k]) => k !== 'fp'), ...fps.slice(1), ['ack', 'on']] });
		// the page was loaded (rep1.hidden); now an original disappears
		const gone = join(cd, 'DISCOVERY A', 'OD-003 Scan.pdf');
		const keep = readFileSync(gone);
		rmSync(gone);
		const afterRemoval = await s.c.activate(i1.importId, { override: [...rep1.hidden, ['ack', 'on']] });
		const activeWhileRemoved = await s.c.activeVersion();
		writeFileSync(gone, keep);
		const restored = await s.c.activate(i1.importId, { override: [...rep1.hidden, ['ack', 'on']] });
		const activeAfterRestore = await s.c.activeVersion();
		// carry-forward: same defects, reordered -> no acknowledgement
		const iR = await s.c.importPkg(cd, R.pkgDir);
		const repR = await s.c.report(iR.importId);
		const actR = await s.c.activate(iR.importId, { ack: false });
		// a new defect: the same package against a folder without OD-004 (new ORIG_MISSING warning)
		const cd2 = join(base, 'case2');
		cpSync(cd, cd2, { recursive: true });
		rmSync(join(cd2, 'DISCOVERY A', 'OD-004 Photo.jpg'));
		const d2 = join(base, 'data2');
		const s2 = await pool.up(d2, { name: 'policy-newdefect' });
		const a2 = await ctx.importActivate(s2, c1, { caseDir: cd });
		const iN = await s2.c.importPkg(cd2, c2.pkgDir);
		const repN = await s2.c.report(iN.importId);
		const noAckN = await s2.c.activate(iN.importId, { ack: false });
		const fpN = repN.hidden.filter(([k]) => k === 'fp');
		const ackN = await s2.c.activate(iN.importId);
		return verdict({
			firstNeedsAck: rep1.needsAck && noAck.status === 409 && noAck.reasons.includes('ACK_REQUIRED'), staleRefused: stale.status === 409 && stale.reasons.includes('ACK_STALE'),
			incompleteRefused: fps.length > 1 && partial.status === 409 && partial.reasons.includes('ACK_INCOMPLETE'),
			removedAfterLoadRefused: afterRemoval.status === 409 && /no longer matches what was previewed|revalidating/.test(afterRemoval.error ?? '') && activeWhileRemoved === null,
			restoredAccepted: restored.status === 303 && activeAfterRestore === v1,
			reorderedCarriesForward: !repR.needsAck && actR.status === 303 && (await s.c.activeVersion()) === R.resultsVersion,
			newDefectNeedsAck: a2.ok && repN.needsAck && repN.codes.ORIG_MISSING === 'warning' && fpN.length >= 1 && noAckN.status === 409 && noAckN.reasons.includes('ACK_REQUIRED') && ackN.status === 303,
		}, { noAck: noAck.reasons, stale: stale.reasons, partial: partial.reasons, fps: fps.length, afterRemoval: afterRemoval.error, restored: restored.error ?? restored.location, repRNeedsAck: repR.needsAck, actR: actR.error ?? actR.location, newDefect: { fps: fpN.length, noAck: noAckN.reasons, ack: ackN.error ?? ackN.location } });
	});

	await S('POLICY-CASE-SCOPE', "case scoping: warnings trusted for case A never waive the same warnings for case B (same folder, same content, other case id); B's acknowledgement does not change A", async () => {
		const base = sub('scope');
		const B = await mk('scopeB', { caseDir: c1.caseDir, caseId: 'e2e-case-b' });
		const data = join(base, 'data');
		const s = await pool.up(data, { name: 'scope' });
		const a = await ctx.importActivate(s, c1);
		const iB = await s.c.importPkg(c1.caseDir, B.pkgDir);
		const repB = await s.c.report(iB.importId);
		const noAck = await s.c.activate(iB.importId, { ack: false });
		const ack = await s.c.activate(iB.importId);
		const pointers = L.q(data, 'SELECT case_id, version_id FROM work.active ORDER BY case_id');
		const trustedA = L.q(data, "SELECT count(*) AS n FROM work.trusted_warning WHERE case_id = 'e2e-case'").at(0)?.n;
		return verdict({
			aActive: a.ok, bNeedsAck: repB.needsAck && repB.hidden.filter(([k]) => k === 'fp').length > 0, bRefusedWithoutAck: noAck.status === 409 && noAck.reasons.includes('ACK_REQUIRED'),
			bActivatedWithAck: ack.status === 303, bothPointers: JSON.stringify(pointers) === JSON.stringify([{ case_id: 'e2e-case', version_id: v1 }, { case_id: 'e2e-case-b', version_id: B.resultsVersion }]),
		}, { pointers, newFpsB: repB.hidden.filter(([k]) => k === 'fp').length, trustedA, noAck: noAck.reasons });
	});

	await S('USERWORK-TABLE', 'a user-work table defined through UserWork.defineTable (rows restored by importAll) is enumerated, survives a SIGKILL and a graceful restart of the server, and is in the server-written backups', async () => {
		const base = sub('uwt');
		const data = join(base, 'data');
		let s = await pool.up(data, { name: 'uwt', env: { CLEARCASE_USERWORK_BACKUP_DELAY_MS: '200' } });
		const a = await ctx.importActivate(s, c1);
		const ports = s.ports;
		await s.stop('SIGTERM');
		const rows = [{ id: 'r1', label: 'first e2e row', amount: 12 }, { id: 'r2', label: 'second e2e row', amount: 34 }];
		const child = (...args) => { const r = spawnSync(process.execPath, [join(import.meta.dirname, 'userwork-table.ts'), data, ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`userwork-table.ts ${args[0]}: ${r.stderr.slice(-800)}`); return JSON.parse(r.stdout.trim().split('\n').at(-1)); };
		const defined = child('define', JSON.stringify(rows));
		s = await pool.up(data, { name: 'uwt-1', ports, env: { CLEARCASE_USERWORK_BACKUP_DELAY_MS: '200' } });
		const note = await L.noteAdd(s, v1, 'OD-001', 'UWT note after defineTable');
		await L.sleep(800); // the debounced user-work backup
		await s.stop('SIGKILL');
		s = await pool.up(data, { name: 'uwt-2', ports });
		const alive = (await s.c.get(`${L.vp(v1)}/doc/OD-001`)).status;
		await s.stop('SIGTERM');
		s = await pool.up(data, { name: 'uwt-3', ports });
		await s.stop('SIGTERM');
		const back = child('read');
		const t = back.table, exported = { rows: back.rows };
		const newest = L.backupsIn(data).at(-1);
		const bk = new DatabaseSync(join(data, 'backups', newest), { readOnly: true });
		let inBackup;
		try { inBackup = bk.prepare('SELECT id, label, amount FROM e2e_ledger ORDER BY id').all().map((r) => ({ ...r })); } finally { bk.close(); }
		return verdict({
			activated: a.ok, noteAcked: note.ok, serverUpAfterKill: alive === 200, enumerated: t?.kind === 'user-work' && t.owner === 'GRS-12 e2e',
			rowsSurvive: JSON.stringify(exported?.rows) === JSON.stringify(rows), inServerBackup: JSON.stringify(inBackup) === JSON.stringify(rows),
		}, { defined, table: t, rows: exported?.rows, newestBackup: newest, inBackup });
	});
}
