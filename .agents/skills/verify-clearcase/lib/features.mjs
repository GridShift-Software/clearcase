// The feature index, found by discovery instead of a hand-written list: every features/*.md except README.md, in name
// order, each checked against the entry contract of features/README.md (an H1 title, one paragraph, then exactly the
// four H2 sections in order; the Driving section starts with "Preconditions:" and marks every action bullet). Drive steps an owner adds live beside its feature file as features/<feature>.steps.mjs
// (`export const steps = [...]`); they are appended to the pilot's steps of lib/drive.mjs in name order. A step must
// name its own module's feature, that feature must have a file, and step ids are unique across all steps.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FEATURES_DIR = resolve(import.meta.dirname, '..', 'features');
export const SECTIONS = ['Sub-features', 'How to get to it (user POV)', 'Driving it with verify-clearcase', 'Gotchas'];
const STEPS_SUFFIX = '.steps.mjs';
const DRIVE_MARK = /[Ss]tep `|[Nn]ot yet driven|Covered in|[Vv]erified unreachable/;
const BLOCK = /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\||<)/;

/** One feature file's title, summary paragraph and contract problems ([] when it keeps the contract). */
export function parseFeature(text) {
	const problems = [];
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	// headings inside fenced code are not headings
	let fence = null;
	const heads = [];
	lines.forEach((l, i) => {
		const f = /^(```|~~~)/.exec(l);
		if (f) { fence = fence === null ? f[1] : fence === f[1] ? null : fence; return; }
		const h = fence === null && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
		if (h) heads.push({ level: h[1].length, text: h[2], line: i });
	});
	const first = lines.findIndex((l) => l.trim());
	const h1 = heads.find((h) => h.level === 1);
	if (!h1 || h1.line !== first) problems.push('the file does not start with an H1 title');
	if (heads.filter((h) => h.level === 1).length > 1) problems.push('more than one H1');
	const h2 = heads.filter((h) => h.level === 2);
	if (h2.map((h) => h.text).join('\n') !== SECTIONS.join('\n')) problems.push(`H2 sections are [${h2.map((h) => h.text).join(' | ')}], expected exactly [${SECTIONS.join(' | ')}] in this order`);
	// between the title and the first H2: exactly one paragraph (consecutive non-blank lines, not a list, heading or code)
	const end = h2.length ? h2[0].line : lines.length;
	const blocks = [];
	for (let i = (h1?.line ?? first) + 1; i < end; i++) {
		if (!lines[i].trim()) continue;
		const start = i;
		while (i < end && lines[i].trim()) i++;
		blocks.push(lines.slice(start, i));
	}
	const para = blocks.length === 1 && !BLOCK.test(blocks[0][0].trim()) ? blocks[0].map((l) => l.trim()).join(' ') : null;
	if (para === null) problems.push(`expected one paragraph between the title and the first H2, found ${blocks.length} block${blocks.length === 1 ? ' that is not a paragraph' : 's'}`);
	const drive = h2.findIndex((h) => h.text === SECTIONS[2]);
	if (drive >= 0) {
		const body = lines.slice(h2[drive].line + 1, h2[drive + 1]?.line ?? lines.length);
		if (!body.find((l) => l.trim())?.startsWith('Preconditions:')) problems.push(`the "${SECTIONS[2]}" section does not start with "Preconditions:"`);
		const unmarked = body.map((l) => /^- \*\*(.+?)\*\*/.exec(l)).filter((m) => m && !/^Proof\b/.test(m[1]) && !DRIVE_MARK.test(m.input)).map((m) => m[1]);
		if (unmarked.length) problems.push(`action bullets without a drive step, "not yet driven" or "verified unreachable": ${unmarked.join(' | ')}`);
	}
	return { title: h1?.text ?? null, summary: para, problems };
}

/** The names in `dir` that discovery considers: hidden ones (editor lock and swap files, `.#x.md`) never count. */
const visible = (dir) => readdirSync(dir).filter((f) => !f.startsWith('.')).sort();

/** A feature file's text and parse, or its read error (a dangling link, a folder) as a contract problem of that file. */
function readFeature(file) {
	try { return parseFeature(readFileSync(file, 'utf8')); }
	catch (e) { return { title: null, summary: null, problems: [`cannot be read: ${e?.code ?? e?.message ?? e}`] }; }
}

/** The discovered feature files of `dir`, in name order: { id, file, title, summary, problems }. */
export function discoverFeatures(dir = FEATURES_DIR) {
	return visible(dir).filter((f) => f.endsWith('.md') && f !== 'README.md')
		.map((f) => ({ id: f.slice(0, -'.md'.length), file: join(dir, f), ...readFeature(join(dir, f)) }));
}

/** The step modules of `dir` (features/<feature>.steps.mjs), in name order. */
export const stepModules = (dir = FEATURES_DIR) => visible(dir).filter((f) => f.endsWith(STEPS_SUFFIX)).map((f) => join(dir, f));

/**
 * The pilot's steps followed by every step module's `steps`, in name order. Throws, naming the module, when a module
 * has no feature file, throws while it is loaded, exports no step array, or has a step without an id, title or run function, a step whose
 * `feature` is not the module's own feature, or a step id used before (pilot steps included).
 */
export async function driveSteps(pilot, dir = FEATURES_DIR) {
	const features = new Set(discoverFeatures(dir).map((f) => f.id));
	const all = [...pilot];
	for (const s of pilot) if (!features.has(s.feature)) throw new Error(`drive step ${s.id} names feature ${s.feature}, which has no features/${s.feature}.md`);
	for (const file of stepModules(dir)) {
		const own = basename(file).slice(0, -STEPS_SUFFIX.length);
		const where = `features/${basename(file)}`;
		if (!features.has(own) || !existsSync(join(dir, `${own}.md`))) throw new Error(`${where}: no feature file features/${own}.md`);
		let mod;
		try { mod = await import(pathToFileURL(file).href); } catch (e) { throw new Error(`${where}: ${e?.message ?? e}`); }
		if (!Array.isArray(mod.steps) || !mod.steps.length) throw new Error(`${where}: exports no steps array`);
		for (const s of mod.steps) {
			if (typeof s?.id !== 'string' || !s.id || typeof s.title !== 'string' || typeof s.run !== 'function') throw new Error(`${where}: a step needs a string id and title and a run function (${JSON.stringify(s?.id)})`);
			if (s.feature !== own) throw new Error(`${where}: step ${s.id} names feature ${JSON.stringify(s.feature)}, not its own feature ${own}`);
			if (all.some((x) => x.id === s.id)) throw new Error(`${where}: step id ${s.id} is already used`);
			all.push(s);
		}
	}
	return all;
}

/** The index as printed by `verify-clearcase features` and recorded in a run's summary. */
export async function featureIndex(pilot, dir = FEATURES_DIR) {
	const features = discoverFeatures(dir);
	const problems = features.flatMap((f) => f.problems.map((p) => `features/${f.id}.md: ${p}`));
	let steps = [];
	try { steps = await driveSteps(pilot, dir); } catch (e) { problems.push(String(e?.message ?? e)); }
	return {
		ok: problems.length === 0,
		problems,
		features: features.map((f) => ({ id: f.id, title: f.title, summary: f.summary, steps: steps.filter((s) => s.feature === f.id).map((s) => s.id) })),
		modules: stepModules(dir).map((f) => basename(f)),
	};
}

export const formatIndex = (ix) => [
	...ix.features.map((f) => `- ${f.title ?? f.id} (features/${f.id}.md): ${f.summary ?? '(no summary)'}\n    steps: ${f.steps.join(', ') || 'none yet (not yet driven)'}`),
	...(ix.modules.length ? [`step modules: ${ix.modules.join(', ')}`] : []),
	...ix.problems.map((p) => `PROBLEM  ${p}`),
	`features: ${ix.ok ? 'PASS' : 'FAIL'}. ${ix.features.length} feature files, ${ix.features.reduce((n, f) => n + f.steps.length, 0)} drive steps, ${ix.problems.length} problems.`,
].join('\n');
