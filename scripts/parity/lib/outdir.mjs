// The runner's output directory against the read-only fixture. Paths are compared by realpath (symlinks and aliases
// followed; a path that does not exist yet resolves through its nearest existing ancestor), and an output that
// overlaps an input in either direction is refused before anything is created, removed or written. Every path the
// runner writes under the output must then resolve to itself: a symlink planted anywhere below the output (or a
// hard-linked file) is refused, so no write follows it into the fixture. The per-run working directory is created
// exclusively (mkdtemp), so an existing .work or any other entry in the output survives; it is removed on exit and on
// SIGINT, SIGTERM and SIGHUP, and a later run sweeps those of runs that were killed outright (SIGKILL), recognised by
// the marker each run writes into its own (never by name alone).
// tests/parity/outdir.test.ts and tests/parity/outdir-e2e.test.ts cover it.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..', '..');

/**
 * The canonical form of a path that may not exist yet: realpath of its nearest existing ancestor plus the rest. A
 * dangling symlink is followed to where it points, relative to the real folder that holds it (as the kernel does),
 * since creating through it would create there.
 */
export function canonical(p) {
	let head = resolve(p);
	const rest = [];
	for (let hops = 0; !existsSync(head); ) {
		const l = lstatSync(head, { throwIfNoEntry: false });
		if (l?.isSymbolicLink() && hops++ < 40) { head = resolve(realpathSync(dirname(head)), readlinkSync(head)); continue; }
		const up = dirname(head);
		if (up === head) break;
		rest.unshift(basename(head));
		head = up;
	}
	return join(realpathSync(head), ...rest);
}

const within = (inner, outer) => { const r = relative(outer, inner); return r === '' || (r !== '..' && !r.startsWith('../') && !isAbsolute(r)); };
const fileAndFolder = (label, p) => (typeof p === 'string' && p ? [[label, p], [`${label} folder`, dirname(resolve(p))]] : []);

/**
 * The read-only inputs named by a fixture locator, path only (nothing is read or hashed, so this runs before
 * loadConfig): the case folder; the v5 main HTML, the bundles-only HTML, the expected examples, the inventory, the
 * summary and the source archive, each with its folder; an optional `fixtureRoot`; a reused package; and a
 * self-parity copy of the v5 HTML (the file only: the mutation proof writes that copy next to the output).
 */
export function locatorInputs(cfg, { appV5Html, repo = REPO } = {}) {
	return [
		['case folder', cfg?.caseFolder],
		['fixture root', cfg?.fixtureRoot],
		...fileAndFolder('v5 main HTML', cfg?.mainHtml?.path),
		...fileAndFolder('v5 bundles-only HTML', cfg?.bundlesOnlyHtml?.path),
		...fileAndFolder('expected examples', cfg?.expectedExamples?.path),
		...fileAndFolder('inventory', cfg?.references?.inventory),
		...fileAndFolder('summary', resolve(repo, typeof cfg?.references?.summary === 'string' ? cfg.references.summary : 'docs/reference/v5-summary.json')),
		...fileAndFolder('source archive', cfg?.archive?.path),
		['package directory', typeof cfg?.pilot?.packageDir === 'string' && cfg.pilot.packageDir ? resolve(repo, cfg.pilot.packageDir) : null],
		['self-parity v5 HTML', appV5Html],
	].filter(([, p]) => typeof p === 'string' && p);
}

/** The read-only inputs of a loaded fixture (tests/e2e/pilot/v5/fixture.mjs loadConfig): its locator's, as loaded. */
export function fixtureInputs(fx, opts = {}) {
	return [
		['case folder', fx.caseFolder],
		...locatorInputs(fx.cfg, opts),
		...fileAndFolder('summary', fx.summaryPath),
		['package directory', fx.packageDir],
	].filter(([, p]) => typeof p === 'string' && p);
}

/** The first overlap between the output and an input, as a message, or null. */
export function overlap(out, inputs) {
	const o = canonical(out);
	for (const [label, p] of inputs) {
		const i = canonical(p);
		if (within(o, i)) return `--out ${out} (${o}) lies inside the read-only ${label} ${i}`;
		if (within(i, o)) return `the read-only ${label} ${i} lies inside --out ${out} (${o})`;
	}
	return null;
}

const refuse = (msg) => { throw Object.assign(new Error(msg), { overlap: true }); };

/**
 * Check an output before anything is touched (throws, path only): it must not overlap an input, and each of
 * `children` (paths relative to it that the caller will write) must resolve to itself. Returns `at(...parts)`, the
 * checked path of a child, which every later write goes through: a child that resolves elsewhere (a symlink anywhere
 * below the output, dangling or not) or an existing file with more than one hard link is refused.
 */
export function checkOutput(out, inputs, children = []) {
	const why = overlap(out, inputs);
	if (why) refuse(`${why}: the fixture is read-only, choose an output directory apart from it`);
	const real = canonical(out);
	const at = (...parts) => {
		const p = join(out, ...parts), c = canonical(p);
		if (c !== join(real, ...parts)) refuse(`${p} resolves to ${c} through a symlink below --out: the runner writes only to real paths inside the output`);
		const l = lstatSync(p, { throwIfNoEntry: false });
		if (l?.isFile() && l.nlink > 1) refuse(`${p} is a file with ${l.nlink} hard links: the runner does not overwrite a file that may share its bytes`);
		return p;
	};
	for (const c of children) at(c);
	return at;
}

/** The runner's working directory in an output, `.work-<pid>-XXXXXX`, and the marker it writes there on creation. */
const WORK = /^\.work-(\d+)-[A-Za-z0-9]{6}$/;
export const WORK_MARKER = '.parity-work.json';
const TOOL = 'clearcase-parity';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** A process's start time in clock ticks since boot (/proc/<pid>/stat field 22), or null where it cannot be read. */
export function pidStartTime(pid) {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		const t = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
		return Number.isSafeInteger(t) ? t : null;
	} catch { return null; }
}

/** The marker of a working directory, if it is a regular file that parses to an object; otherwise null. */
function readMarker(dir) {
	const p = join(dir, WORK_MARKER);
	if (!lstatSync(p, { throwIfNoEntry: false })?.isFile()) return null;
	try { const m = JSON.parse(readFileSync(p, 'utf8')); return m && typeof m === 'object' ? m : null; } catch { return null; }
}

/**
 * Remove the working directories that runs killed outright left in an output. A directory is removed only when the
 * runner itself created it and nobody asked to keep it: it is named `.work-<pid>-XXXXXX`, is a real directory (never a
 * symlink), holds a marker of this tool with `keep: false` and the same pid as its name, and that process is gone or
 * has a different start time (its pid was reused). Anything else, a user's directory, an unmarked or unparsable one,
 * one kept with --keep-work or a live run's, is left alone. Call only on a checked output. Returns the names removed.
 */
export function sweepStaleWork(out, at) {
	const removed = [];
	for (const e of existsSync(out) ? readdirSync(out, { withFileTypes: true }) : []) {
		const m = WORK.exec(e.name);
		if (!m || !e.isDirectory() || !lstatSync(join(out, e.name)).isDirectory()) continue;
		const pid = Number(m[1]), mark = readMarker(join(out, e.name));
		if (mark?.tool !== TOOL || mark.keep !== false || mark.pid !== pid) continue;
		// a live pid counts as this run only while its start time matches (or either is unknown: conservative)
		const start = alive(pid) ? pidStartTime(pid) : undefined;
		if (start !== undefined && (start === null || !Number.isSafeInteger(mark.pidStartTime) || start === mark.pidStartTime)) continue;
		rmSync(at(e.name), { recursive: true, force: true });
		removed.push(e.name);
	}
	return removed;
}

/**
 * Check the output (see checkOutput), sweep stale working directories, then create <out>/views and a fresh
 * <out>/.work-<pid>-XXXXXX holding its marker (`keep` records --keep-work, so later runs never sweep a kept one).
 * Returns { at, views, work, swept }; removing `work` afterwards removes only what this run created.
 */
export function prepareOutput(out, inputs, children = [], { keep = false } = {}) {
	const at = checkOutput(out, inputs, ['views', ...children]);
	const swept = sweepStaleWork(out, at);
	const views = at('views');
	mkdirSync(views, { recursive: true });
	const work = mkdtempSync(at(`.work-${process.pid}-`));
	const marker = { tool: TOOL, pid: process.pid, startedAt: Date.now(), keep: Boolean(keep) };
	const start = pidStartTime(process.pid);
	if (start !== null) marker.pidStartTime = start;
	writeFileSync(join(work, WORK_MARKER), JSON.stringify(marker), { flag: 'wx' });
	return { at, views, work, swept };
}

/** The conventional exit status of a process ended by a signal it handles: 128 plus the signal number. */
export const SIGNALS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/**
 * Remove `dir` on every exit, and turn SIGINT, SIGTERM and SIGHUP into an exit with the conventional status so the
 * removal (and the other exit handlers: the server's and the browser's) runs. SIGKILL cannot be caught; the next
 * run's sweepStaleWork removes what it leaves.
 */
export function removeOnExit(dir) {
	process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
	for (const [sig, code] of Object.entries(SIGNALS)) process.on(sig, () => process.exit(code));
}
