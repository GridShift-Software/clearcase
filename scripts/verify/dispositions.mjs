#!/usr/bin/env bun
// Source-defect dispositions against the parity register (GRS-21, CC-11):
//
//   bun scripts/verify/dispositions.mjs [--md FILE] [--json FILE]
//
// Reads every v5 source defect: the cross-cutting table of docs/reference/defects.md (ID, severity, disposition, owner)
// and the per-view list of docs/reference/view-checklist.md (`S-<view>-<n>` (severity) text), and every entry of the
// intentional-differences register (docs/reference/parity/intentional-differences.json and its register/ fragments).
// A defect has a register disposition when an entry's id, field, reason or source names it (the whole ID, or for a
// table row naming a family such as `S-documents-*`, any member). The imported-data defects (IMPORTED_DATA below,
// a reviewed list: the fault is in the embedded datasets, not in v5's code) must carry an entry of type
// data-correction-deferred-to-pipeline. Writes a Markdown table (--md, default stdout) and a JSON record (--json).
// Exit 0 when every defect has a disposition and every imported-data defect is tagged, 1 otherwise. Reads the
// committed register only; it never writes it and never sets approvedBy.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const REF = join(ROOT, 'docs', 'reference');

/**
 * Defects whose fault is in the imported data (the embedded datasets), not in v5's code, reviewed against their text
 * in defects.md and view-checklist.md. The app shows the imported value and never corrects it silently.
 */
export const IMPORTED_DATA = {
	'S-meta-counts': 'META.textNone and META.emails disagree with the rows; the counts are in the embedded META',
	'S-catalogue-refs': 'bundles.catalogue refs that resolve to no row, and bundle item keys in another namespace, are in the embedded data',
	'S-overview-2': 'META.textNone (237) disagrees with the 255 rows with text status none',
	'S-prescription-frozen': 'risk labels and leap-day dates are precomputed in the embedded prescription dataset',
};

// ---- defects ---------------------------------------------------------------------------------------------------------

const defectsMd = readFileSync(join(REF, 'defects.md'), 'utf8');
const checklist = readFileSync(join(REF, 'view-checklist.md'), 'utf8');
const defects = new Map();
for (const line of defectsMd.split('\n')) {
	const cells = line.split('|').map((c) => c.trim());
	if (cells.length < 8 || !/^S-/.test(cells[1])) continue;
	for (const id of cells[1].match(/S-[A-Za-z_0-9-]+(?:-\*)?/g) ?? []) defects.set(id.replace(/-$/, '-*'), { id: id.replace(/-$/, '-*'), source: 'defects.md', severity: cells[2], text: cells[3], disposition: cells[5], owner: cells[6] });
}
for (const m of checklist.matchAll(/^\s*- `(S-[A-Za-z_0-9]+-\d+)` \((high|medium|low)\) (.+)$/gm)) {
	if (!defects.has(m[1])) defects.set(m[1], { id: m[1], source: 'view-checklist.md', severity: m[2], text: m[3].replace(/ Evidence: .*$/, ''), disposition: null, owner: null });
}

// ---- register --------------------------------------------------------------------------------------------------------

const PAR = join(REF, 'parity');
const files = ['intentional-differences.json', ...readdirSync(join(PAR, 'register')).filter((f) => f.endsWith('.json')).sort().map((f) => join('register', f))];
const entries = files.flatMap((f) => (JSON.parse(readFileSync(join(PAR, f), 'utf8')).entries ?? []).map((e) => ({ ...e, file: `docs/reference/parity/${f}` })));
const textOf = (e) => [e.id, ...(Array.isArray(e.field) ? e.field : [e.field]), e.reason, e.source, e.owner].filter(Boolean).join(' ');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function citing(id) {
	const re = id.endsWith('-*') ? new RegExp(`${esc(id.slice(0, -1))}\\d+\\b`) : new RegExp(`${esc(id)}(?![\\w-]*\\d)\\b`);
	return entries.filter((e) => re.test(textOf(e)));
}

const rows = [...defects.values()].map((d) => {
	const cite = citing(d.id);
	const data = IMPORTED_DATA[d.id] ?? null;
	const tagged = cite.some((e) => e.type === 'data-correction-deferred-to-pipeline');
	const status = !cite.length ? 'no register entry' : data && !tagged ? 'imported data, not tagged' : 'registered';
	return { ...d, importedData: data, entries: cite.map((e) => ({ id: e.id, type: e.type, view: e.view, file: e.file })), status };
});
const count = (s) => rows.filter((r) => r.status === s).length;
const summary = { defects: rows.length, registered: count('registered'), noEntry: count('no register entry'), importedDataUntagged: count('imported data, not tagged'), bySeverity: Object.fromEntries(['high', 'medium', 'low'].map((s) => [s, { total: rows.filter((r) => r.severity === s).length, noEntry: rows.filter((r) => r.severity === s && r.status !== 'registered').length }])), registerEntries: entries.length, byType: entries.reduce((a, e) => ((a[e.type] = (a[e.type] ?? 0) + 1), a), {}) };

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 140);
const md = [
	`| Defect | Severity | Listed in | Status | Register entries | Imported data |`,
	`| --- | --- | --- | --- | --- | --- |`,
	...rows.map((r) => `| \`${r.id}\` | ${r.severity} | ${r.source} | ${r.status} | ${r.entries.map((e) => `${e.id} (${e.type})`).join(', ') || '–'} | ${r.importedData ? 'yes' : ''} |`),
].join('\n');
if (arg('--md')) writeFileSync(arg('--md'), md + '\n'); else console.log(md);
if (arg('--json')) writeFileSync(arg('--json'), JSON.stringify({ summary, imported: IMPORTED_DATA, rows }, null, 1));
console.error(`dispositions: ${summary.defects} defects, ${summary.registered} registered, ${summary.noEntry} with no register entry, ${summary.importedDataUntagged} imported-data defects not tagged data-correction-deferred-to-pipeline; ${summary.registerEntries} register entries ${JSON.stringify(summary.byType)}`);
process.exit(summary.noEntry || summary.importedDataUntagged ? 1 : 0);
