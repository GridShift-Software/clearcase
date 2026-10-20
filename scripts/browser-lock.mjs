#!/usr/bin/env bun
// Browser admission: which command a browser job runs through to take a slot of the host's browser lock. The local
// gate, scripts/verify/evidence.sh and the hosted runner (verify-clearcase-hosted, and gate:hosted through it) all
// resolve it here, in this order:
//   BROWSER_LOCK set, even empty: refused. It is the retired spelling, so an old export cannot quietly mean anything.
//   CLEARCASE_BROWSER_LOCK=none: browser jobs run without a slot, deliberately (CI, a host with no workspace lock).
//   CLEARCASE_BROWSER_LOCK=<absolute path to an executable file>: that command takes the slot.
//   CLEARCASE_BROWSER_LOCK set to anything else, empty included: refused.
//   unset: <workspace>/orch-bin/browser-lock, the workspace being the directory above the repository's git-common-dir
//   (<workspace>/clearcase/.git), so the main checkout and every linked worktree find the same lock; refused when that
//   is not an executable file.
// `bun scripts/browser-lock.mjs` prints the resolved command (an empty line for none) on stdout and what admitted it
// on stderr, exit 0; or the problem on stderr, exit 2. It imports nothing from the repository, so plain bun runs it.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const ADMISSION_FIX = "set CLEARCASE_BROWSER_LOCK to the absolute path of the workspace's orch-bin/browser-lock, or to none to run browser jobs without a slot (CI)";
const SOURCES = { explicit: 'CLEARCASE_BROWSER_LOCK', discovered: 'discovered from git-common-dir', none: 'CLEARCASE_BROWSER_LOCK=none: browser steps take no slot' };
const executable = (p) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };

/**
 * The browser lock `env` admits for the checkout at `repo`: `{ lock, source }`, with `lock` an absolute command or null
 * for none and `source` one of explicit, discovered, none; or `{ problem }`, to report with ADMISSION_FIX.
 */
export function resolveBrowserLock({ env = process.env, repo = process.cwd() } = {}) {
	if (env.BROWSER_LOCK !== undefined) return { problem: `BROWSER_LOCK is the retired spelling (set to ${JSON.stringify(env.BROWSER_LOCK)}); unset it` };
	const explicit = env.CLEARCASE_BROWSER_LOCK;
	if (explicit === 'none') return { lock: null, source: 'none' };
	if (explicit !== undefined) {
		if (isAbsolute(explicit) && executable(explicit)) return { lock: explicit, source: 'explicit' };
		return { problem: `CLEARCASE_BROWSER_LOCK=${JSON.stringify(explicit)} is neither none nor an absolute path to an executable file` };
	}
	const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8' });
	if (r.error || r.status !== 0) return { problem: `no browser admission: CLEARCASE_BROWSER_LOCK is unset and git names no common directory for ${repo} (${(r.error?.message ?? r.stderr).trim()})` };
	const lock = resolve(repo, r.stdout.trim(), '..', '..', 'orch-bin', 'browser-lock');
	if (!executable(lock)) return { problem: `no browser admission: CLEARCASE_BROWSER_LOCK is unset and ${lock} is not an executable file` };
	return { lock, source: 'discovered' };
}

/** One line naming what admits browser jobs. */
export const describeAdmission = ({ lock, source }) => `browser lock ${lock ?? 'none'} (${SOURCES[source]})`;

if (import.meta.main) {
	const admission = resolveBrowserLock({ repo: resolve(import.meta.dirname, '..') });
	if (admission.problem) {
		console.error(`${admission.problem}; ${ADMISSION_FIX}`);
		process.exit(2);
	}
	console.error(describeAdmission(admission));
	console.log(admission.lock ?? '');
}
