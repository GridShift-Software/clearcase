// The live doctor of a hosted instance: is the server on this URL the one this run started, serving this run's
// artifact on workerd with this run's fixture and live bindings? One GET /health plus /proc. Read-only.
//
// `expect`: { revision, buildId, profile, runId, fixtureSha256, pid (start:hosted's), persist (absolute) }.
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';

/** Processes descended from `root` (inclusive), each with its executable's base name and command line. */
export function tree(root) {
	const all = new Map();
	for (const name of readdirSync('/proc')) {
		if (!/^\d+$/.test(name)) continue;
		try {
			const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
			const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
			let exe = '?';
			try { exe = readlinkSync(`/proc/${name}/exe`).split('/').pop(); } catch {}
			all.set(Number(name), { pid: Number(name), ppid, exe, cmdline: readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean) });
		} catch {}
	}
	const ids = new Set([root]);
	for (let grew = true; grew;) {
		grew = false;
		for (const p of all.values()) if (!ids.has(p.pid) && ids.has(p.ppid)) { ids.add(p.pid); grew = true; }
	}
	return [...ids].map((id) => all.get(id)).filter(Boolean);
}

export async function liveDoctor({ url, expect }) {
	const checks = [];
	const check = (name, pass, got) => checks.push({ name, pass: !!pass, got });
	let health = null, status = null;
	try {
		const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
		status = res.status;
		health = await res.json();
	} catch (e) {
		check('health', false, String(e?.message ?? e));
		return { pass: false, checks, health };
	}
	check('health', status === 200 && health?.ok === true, { status, ok: health?.ok });
	check('runtime', health?.runtime === 'Cloudflare-Workers', health?.runtime);
	const b = health?.build ?? {};
	check('build.revision', b.revision === expect.revision, b.revision);
	check('build.buildId', b.buildId === expect.buildId, b.buildId);
	check('build.profile', b.profile === expect.profile, b.profile);
	check('build.dirty', b.dirty === false, b.dirty);
	check('gate.runId', health?.gate?.runId === `clearcase-test-double:hosted-gate/${expect.runId}`, health?.gate?.runId);
	check('gate.fixtureSha256', health?.gate?.fixtureSha256 === expect.fixtureSha256, health?.gate?.fixtureSha256);
	check('identityProvider', health?.identityProvider === 'test-identity-double', health?.identityProvider);
	const p = health?.probe ?? {};
	for (const name of ['DB', 'BUCKET', 'ASSETS']) check(`binding.${name}`, p.bindings?.[name] === true, p.bindings?.[name]);
	check('probe.d1', p.probes?.d1 === true, p.probes?.d1);
	check('probe.r2', p.probes?.r2 === true, p.probes?.r2);
	// The answering server must be this run's: start:hosted's process, a Wrangler under it on this run's persist
	// directory, and a native workerd under that Wrangler.
	const procs = tree(expect.pid);
	const starter = procs.find((x) => x.pid === expect.pid);
	check('process.start', starter && starter.cmdline.some((a) => a.endsWith('scripts/pilot/hosted.ts')) && starter.cmdline.includes('start'), starter?.cmdline.join(' ') ?? 'not running');
	const wrangler = procs.find((x) => x.cmdline.some((a) => a.endsWith('wrangler/bin/wrangler.js')) && x.cmdline.includes('dev'));
	const persist = wrangler ? wrangler.cmdline[wrangler.cmdline.indexOf('--persist-to') + 1] : null;
	check('process.wrangler', wrangler && persist === expect.persist, wrangler ? `${wrangler.pid} --persist-to ${persist}` : 'no wrangler dev under start:hosted');
	check('process.workerd', procs.some((x) => x.exe === 'workerd'), procs.filter((x) => x.exe === 'workerd').map((x) => x.pid));
	return { pass: checks.every((c) => c.pass), checks, health };
}

export const formatDoctor = (r) => r.checks.map((c) => `  ${c.pass ? 'ok  ' : 'FAIL'} ${c.name}${c.pass ? '' : ` (got ${JSON.stringify(c.got)})`}`).join('\n');
