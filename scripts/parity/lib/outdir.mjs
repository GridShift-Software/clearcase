// The runner's output directory against the read-only fixture. Paths are compared by realpath (symlinks and aliases
// followed; a path that does not exist yet resolves through its nearest existing ancestor), and an output that
// overlaps an input in either direction is refused before anything is created, removed or written. The per-run
// working directory is created exclusively (mkdtemp), so an existing .work or any other entry in the output survives.
// tests/parity/outdir.test.ts covers it.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * The canonical form of a path that may not exist yet: realpath of its nearest existing ancestor plus the rest. A
 * dangling symlink is followed to where it points, since creating through it would create there.
 */
export function canonical(p) {
	let head = resolve(p);
	const rest = [];
	for (let hops = 0; !existsSync(head); ) {
		const l = lstatSync(head, { throwIfNoEntry: false });
		if (l?.isSymbolicLink() && hops++ < 40) { head = resolve(dirname(head), readlinkSync(head)); continue; }
		const up = dirname(head);
		if (up === head) break;
		rest.unshift(basename(head));
		head = up;
	}
	return join(realpathSync(head), ...rest);
}

const within = (inner, outer) => { const r = relative(outer, inner); return r === '' || (r !== '..' && !r.startsWith('../') && !isAbsolute(r)); };

/**
 * The read-only inputs of a run, labelled for messages: the case folder, the v5 main HTML and the folder it opens
 * from, the expected examples, the inventory, the summary, a reused package and a self-parity copy of the v5 HTML (the
 * file only: the mutation proof writes that copy next to the output).
 */
export function fixtureInputs(fx, { appV5Html } = {}) {
	const html = fx.cfg?.mainHtml?.path;
	return [
		['case folder', fx.caseFolder],
		['v5 main HTML', html], ['v5 HTML folder', html && dirname(html)],
		['expected examples', fx.cfg?.expectedExamples?.path], ['inventory', fx.cfg?.references?.inventory], ['summary', fx.summaryPath],
		['package directory', fx.packageDir],
		['self-parity v5 HTML', appV5Html],
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

/**
 * Refuse an overlapping output (throws, nothing touched), then create <out>/views and a fresh <out>/.work-XXXXXX.
 * Returns { views, work }; removing `work` afterwards removes only what this run created.
 */
export function prepareOutput(out, inputs) {
	const why = overlap(out, inputs);
	if (why) throw Object.assign(new Error(`${why}: the fixture is read-only, choose an output directory apart from it`), { overlap: true });
	const views = join(out, 'views');
	mkdirSync(views, { recursive: true });
	return { views, work: mkdtempSync(join(out, '.work-')) };
}
