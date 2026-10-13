// The v5 source defects and the register entries that name them, shared by dispositions.mjs (the report) and
// register-dispositions.mjs (the writer, whose --check fails on the same gaps). `ref` is a docs/reference folder.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Every defect of defects.md (the cross-cutting table) and view-checklist.md (the per-view list), by id. */
export function readDefects(ref) {
	const defectsMd = readFileSync(join(ref, 'defects.md'), 'utf8');
	const checklist = readFileSync(join(ref, 'view-checklist.md'), 'utf8');
	const defects = new Map();
	const unparsedRows = [];
	for (const line of defectsMd.split('\n')) {
		const cells = line.split('|').map((c) => c.trim());
		if (!/^S-/.test(cells[1] ?? '')) continue;
		if (cells.length < 8) { unparsedRows.push(cells[1]); continue; }
		for (const id of cells[1].match(/S-[A-Za-z_0-9-]+(?:-\*)?/g) ?? []) defects.set(id.replace(/-$/, '-*'), { id: id.replace(/-$/, '-*'), source: 'defects.md', severity: cells[2], text: cells[3], disposition: cells[5], owner: cells[6] });
	}
	for (const m of checklist.matchAll(/^\s*- `(S-[A-Za-z_0-9]+-\d+)` \((high|medium|low)\) (.+)$/gm)) {
		if (!defects.has(m[1])) defects.set(m[1], { id: m[1], source: 'view-checklist.md', severity: m[2], text: m[3].replace(/ Evidence: .*$/, ''), disposition: null, owner: null });
	}
	return { defects, unparsedRows };
}

const textOf = (e) => [e.id, ...(Array.isArray(e.field) ? e.field : [e.field]), e.reason, e.source, e.owner].filter(Boolean).join(' ');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The entries that name defect `id` (the whole ID; for a family such as `S-documents-*`, any member). */
export function citing(entries, id) {
	const re = id.endsWith('-*') ? new RegExp(`${esc(id.slice(0, -1))}\\d+\\b`) : new RegExp(`${esc(id)}(?![\\w-]*\\d)\\b`);
	return entries.filter((e) => re.test(textOf(e)));
}

/** Whether `id` (an entry's `source`) is a listed defect, or a member of a listed family such as `S-documents-*`. */
export const isListed = (defects, id) => defects.has(id) || [...defects.keys()].some((k) => k.endsWith('-*') && id.startsWith(k.slice(0, -1)));
