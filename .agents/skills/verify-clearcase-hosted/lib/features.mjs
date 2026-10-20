// The feature index by discovery: every features/*.md (README aside) keeps the entry contract (an H1, one paragraph,
// then the H2s Sub-features, How to get to it (user POV), Driving it with verify-clearcase-hosted and Gotchas), and
// every drive step names a feature file that names the step back. No hand-written list.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { steps } from './steps.mjs';

export const FEATURES = resolve(import.meta.dirname, '..', 'features');
const H2 = ['Sub-features', 'How to get to it (user POV)', 'Driving it with verify-clearcase-hosted', 'Gotchas'];

export function featureIndex(dir = FEATURES, driveSteps = steps) {
	const problems = [], features = [];
	const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md').sort() : [];
	for (const f of files) {
		const id = f.slice(0, -3), text = readFileSync(join(dir, f), 'utf8');
		const lines = text.split('\n');
		const title = lines[0]?.startsWith('# ') ? lines[0].slice(2).trim() : null;
		if (!title) problems.push(`${f}: the first line is not an H1`);
		const firstH2 = lines.findIndex((l) => l.startsWith('## '));
		const intro = lines.slice(1, firstH2 < 0 ? undefined : firstH2).join('\n').trim();
		if (!intro || intro.includes('\n\n') || /^[-*\d]/.test(intro)) problems.push(`${f}: the H1 must be followed by exactly one paragraph`);
		const h2 = lines.filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim());
		if (JSON.stringify(h2) !== JSON.stringify(H2)) problems.push(`${f}: the H2s are ${JSON.stringify(h2)}, expected ${JSON.stringify(H2)}`);
		const driving = text.split('## Driving it with verify-clearcase-hosted')[1]?.split('\n## ')[0] ?? '';
		const named = [...driving.matchAll(/Step `([a-z0-9-]+)`/g)].map((m) => m[1]);
		for (const s of named) if (!driveSteps.some((d) => d.id === s && d.feature === id)) problems.push(`${f}: names step ${s}, which lib/steps.mjs does not drive for ${id}`);
		features.push({ id, title, steps: driveSteps.filter((d) => d.feature === id).map((d) => d.id) });
	}
	const ids = new Set();
	for (const s of driveSteps) {
		if (ids.has(s.id)) problems.push(`step ${s.id} is defined twice`);
		ids.add(s.id);
		if (!files.includes(`${s.feature}.md`)) problems.push(`step ${s.id} names feature ${s.feature}, which has no features/${s.feature}.md`);
		else if (!readFileSync(join(dir, `${s.feature}.md`), 'utf8').includes(`Step \`${s.id}\``)) problems.push(`features/${s.feature}.md does not name its step \`${s.id}\``);
	}
	return { ok: !problems.length, problems, features };
}

export const formatIndex = (ix) => [...ix.features.map((f) => `${f.id.padEnd(20)}${f.title}${f.steps.length ? `  [${f.steps.join(', ')}]` : '  [not driven]'}`), ...ix.problems.map((p) => `PROBLEM ${p}`)].join('\n');
