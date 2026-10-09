// Live doctor: is the ClearCase instance answering at `url` the one this run started? Read-only: one GET of
// /api/health plus a look at /proc/<pid>/cmdline. Every expectation is checked and reported; any mismatch fails.
// A stale server, one from another build or one on another data directory fails here, whatever else it answers.
import { readFileSync, realpathSync } from 'node:fs';

const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const cmdline = (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return null; } };

/**
 * expect: { pid, dataDir, appPort, originalsPort, originalsOrigin?, build (the run's clearcase-build.json object),
 *           bun (the packageManager pin), startScript? (the start.ts the pid must run) }
 * Returns { pass, checks: [{ name, pass, want, got }], health }.
 */
export async function liveDoctor({ url, expect, timeoutMs = 5000 }) {
	const checks = [];
	const check = (name, want, got, pass = JSON.stringify(want) === JSON.stringify(got)) => checks.push({ name, pass, want, got });
	let health = null;
	try {
		const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
		const text = await r.text();
		check('http', 200, r.status);
		health = JSON.parse(text);
	} catch (e) {
		check('reachable', `${url}/api/health answers`, String(e?.message ?? e), false);
		return { pass: false, checks, health };
	}
	const i = health?.instance ?? {};
	check('pid', expect.pid, i.pid);
	check('dataDir', real(expect.dataDir), i.dataDir ? real(i.dataDir) : i.dataDir);
	check('appPort', expect.appPort, i.appPort);
	check('originalsPort', expect.originalsPort, i.originalsPort);
	if (expect.originalsOrigin) check('originalsOrigin', expect.originalsOrigin, i.originalsOrigin);
	const b = expect.build ?? {};
	check('build.revision', b.revision, i.build?.revision);
	check('build.buildId', b.buildId, i.build?.buildId);
	check('build.builtAt', b.builtAt, i.build?.builtAt);
	check('build.stamp', b, i.build ?? null);
	check('bun', expect.bun, i.bun);
	const p = health.pragmas;
	check('pragmas.main.journal_mode', 'wal', p?.main?.journal_mode);
	check('pragmas.work.journal_mode', 'delete', p?.work?.journal_mode);
	check('pragmas.main.synchronous', 2, p?.main?.synchronous);
	check('pragmas.work.synchronous', 2, p?.work?.synchronous);
	check('storageError', null, health.storageError ?? null);
	check('recovery', null, health.recovery ?? null);
	if (expect.startScript) {
		const argv = cmdline(expect.pid);
		check('process', `pid ${expect.pid} runs ${expect.startScript}`, argv ? argv.join(' ') : 'no such process', !!argv?.includes(expect.startScript));
	}
	return { pass: checks.every((c) => c.pass), checks, health };
}

export const formatDoctor = (r) => r.checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'}     ${c.name.padEnd(26)} ${c.pass ? JSON.stringify(c.got) : `want ${JSON.stringify(c.want)}, got ${JSON.stringify(c.got)}`}`.slice(0, 400)).join('\n');
