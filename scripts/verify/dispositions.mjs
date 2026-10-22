#!/usr/bin/env bun
// Source-defect dispositions against the parity register (GRS-21, CC-11):
//
//   bun scripts/verify/dispositions.mjs [--reference DIR] [--md FILE] [--json FILE]
//
// Reads every v5 source defect: the cross-cutting table of docs/reference/defects.md (ID, severity, disposition, owner)
// and the per-view list of docs/reference/view-checklist.md (`S-<view>-<n>` (severity) text), and every entry of the
// intentional-differences register (docs/reference/parity/intentional-differences.json and its register/ fragments).
// A defect has a register disposition when an entry's id, field, reason or source names it (the whole ID, or for a
// table row naming a family such as `S-documents-*`, any member). The imported-data defects (IMPORTED_DATA below,
// a reviewed list: the fault is in the embedded datasets, not in v5's code) must carry an entry of type
// data-correction-deferred-to-pipeline. --reference reads a synthetic docs/reference copy. Writes a Markdown table
// (--md, default stdout) and a JSON record (--json).
// Exit 0 when every defect has a disposition and every imported-data defect is tagged, 1 otherwise. Reads the
// committed register only; it never writes it and never sets approvedBy.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { citing, readDefects } from './lib/defects.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const REF = resolve(arg('--reference') ?? join(ROOT, 'docs', 'reference'));

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

const { defects, unparsedRows } = readDefects(REF);

// ---- register --------------------------------------------------------------------------------------------------------

const PAR = join(REF, 'parity');
const files = ['intentional-differences.json', ...readdirSync(join(PAR, 'register')).filter((f) => f.endsWith('.json')).sort().map((f) => join('register', f))];
const entries = files.flatMap((f) => (JSON.parse(readFileSync(join(PAR, f), 'utf8')).entries ?? []).map((e) => ({ ...e, file: `docs/reference/parity/${f}` })));
const rows = [...defects.values()].map((d) => {
	const cite = citing(entries, d.id);
	const data = IMPORTED_DATA[d.id] ?? null;
	const tagged = cite.some((e) => e.type === 'data-correction-deferred-to-pipeline');
	const status = !cite.length ? 'no register entry' : data && !tagged ? 'imported data, not tagged' : 'registered';
	return { ...d, importedData: data, entries: cite.map((e) => ({ id: e.id, type: e.type, view: e.view, file: e.file })), status };
});
// a reviewed imported-data id that names no defect would never be checked: that is an error, not a pass
const unknownImported = Object.keys(IMPORTED_DATA).filter((id) => !defects.has(id));
const count = (s) => rows.filter((r) => r.status === s).length;
const summary = { defects: rows.length, registered: count('registered'), noEntry: count('no register entry'), importedDataUntagged: count('imported data, not tagged'), bySeverity: Object.fromEntries(['high', 'medium', 'low'].map((s) => [s, { total: rows.filter((r) => r.severity === s).length, noEntry: rows.filter((r) => r.severity === s && r.status !== 'registered').length }])), unknownImported, unparsedRows, registerEntries: entries.length, byType: entries.reduce((a, e) => ((a[e.type] = (a[e.type] ?? 0) + 1), a), {}) };

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 140);
const md = [
	`| Defect | Severity | Listed in | Status | Register entries | Imported data |`,
	`| --- | --- | --- | --- | --- | --- |`,
	...rows.map((r) => `| \`${r.id}\` | ${r.severity} | ${r.source} | ${r.status} | ${r.entries.map((e) => `${e.id} (${e.type})`).join(', ') || '–'} | ${r.importedData ? 'yes' : ''} |`),
].join('\n');
if (arg('--md')) writeFileSync(arg('--md'), md + '\n'); else console.log(md);
if (arg('--json')) writeFileSync(arg('--json'), JSON.stringify({ summary, imported: IMPORTED_DATA, rows }, null, 1));
console.error(`dispositions: ${summary.defects} defects, ${summary.registered} registered, ${summary.noEntry} with no register entry, ${summary.importedDataUntagged} imported-data defects not tagged data-correction-deferred-to-pipeline; ${summary.registerEntries} register entries ${JSON.stringify(summary.byType)}`);
if (unparsedRows.length) console.error(`dispositions: defects.md rows that do not parse (fewer than 8 cells): ${unparsedRows.join(', ')}`);
if (unknownImported.length) console.error(`dispositions: IMPORTED_DATA names no listed defect: ${unknownImported.join(', ')}`);
process.exit(summary.noEntry || summary.importedDataUntagged || unknownImported.length || unparsedRows.length ? 1 : 0);
