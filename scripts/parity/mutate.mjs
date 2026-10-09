#!/usr/bin/env bun
// Mutation proof on the real sample: plant one regression per category in a scratch copy, run the harness against
// it and require that it fails with an unregistered difference where the regression shows. Local evidence only:
// mutants, builds and per-view diffs stay under --out (inside .local/), which is removed unless --keep.
//
//   bun scripts/parity/mutate.mjs --fixture-config .local/v5-verification.json --out .local/parity-mutants [--only ID,...] [--keep]
//
// App mutants: `git archive HEAD` into <out>/<id>/src, one exact text replacement (it must match exactly once), the
// installed node_modules reflinked, `bun run --bun build` there, then `parity --app-root` on the affected views. The
// register CRUD category runs v5 against a scratch copy of the v5 HTML with a planted register defect
// (`parity --app-v5-html`), because the pilot has no register yet; its unmutated copy is the self-parity control.
// Exit 0 when every mutant is caught and the control passes; 1 otherwise; 2 on setup errors.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
const die = (m) => { console.error(`mutate: ${m}`); process.exit(2); };
const cfgFile = resolve(opt('fixture-config') ?? die('--fixture-config FILE is required'));
const out = resolve(opt('out') ?? die('--out DIR is required'));
if (!(out + '/').startsWith(join(REPO, '.local') + '/')) die(`--out must lie inside ${join(REPO, '.local')}/ (mutants and diffs are local evidence)`);
const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));

/** Each mutant: category, files to change (exact find -> replace), views to run, and the path family that must fail. */
const MUTANTS = [
	{ id: 'filter-sort', category: 'filter/sort', views: 'chronology', expect: /^sweep\.filter_sort_(ui|engine)\./, what: 'chronology sorts compare with localeCompare instead of code units (the parity trial mutation)',
		edits: [['src/lib/local-case/chronology.ts', '(a[sort] < b[sort] ? -1 : a[sort] > b[sort] ? 1 : 0)', 'String(a[sort]).localeCompare(String(b[sort]))']] },
	{ id: 'calculation', category: 'calculation', views: 'overview', expect: /^kpi\.invoices\.value$/, what: 'the Invoices tile counts register rows of type invoice instead of the quantum invoice count',
		edits: [['src/routes/v/[vid]/overview/+page.svelte', '{(o.quantum?.invoiceCount ?? c.invoices).toLocaleString(\'en\')}', '{c.invoices.toLocaleString(\'en\')}']] },
	{ id: 'export', category: 'export', views: 'chronology', expect: /^export\.export_csv\.row\.\d+\.to$/, what: 'the chronology CSV writes the sender into the to column',
		edits: [['src/routes/v/[vid]/chronology/+page.svelte', 'r.subject, r.sender, r.to, r.docType', 'r.subject, r.sender, r.sender, r.docType']] },
	{ id: 'navigation-focus', category: 'navigation/focus', views: 'overview,chronology', expect: /^focus\.after_nav$/, what: 'after navigation focus goes to the main region instead of the page heading',
		edits: [['src/routes/+layout.svelte', "document.querySelector<HTMLElement>('[data-page-heading]')?.focus({ preventScroll })", "document.querySelector<HTMLElement>('#main')?.focus({ preventScroll })"]] },
	{ id: 'rendered-text', category: 'rendered text', views: 'overview', expect: /^kpi\.documents_(indexed|counted)\./, what: 'the Documents indexed tile is relabelled',
		edits: [['src/routes/v/[vid]/overview/+page.svelte', '<h2 id="kpi-docs">Documents indexed</h2>', '<h2 id="kpi-docs">Documents counted</h2>']] },
	{ id: 'register-crud', category: 'register CRUD', views: 'deadlines_tab', v5: true, expect: /^sweep\.register_edit\./, what: 'deleting a deadline removes the row after the chosen one (v5 copy; the pilot has no register yet)',
		edits: [["delDeadline(i){const s=load('ess_dcs_deadlines_v1',[]);s.splice(i,1);", "delDeadline(i){const s=load('ess_dcs_deadlines_v1',[]);s.splice(i+1,1);"]] },
	{ id: 'control-v5', category: 'control', views: 'overview,chronology,deadlines_tab,timesheet_tab', v5: true, control: true, what: 'an unmutated copy of the v5 HTML against v5: no difference at all', edits: [] },
];

const only = opt('only')?.split(',');
const results = [];
const run = (args, cwd = REPO) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 26, env: process.env });
const replaceOnce = (text, find, repl, where) => {
	const n = text.split(find).length - 1;
	if (n !== 1) die(`${where}: the mutation text occurs ${n} times (must be exactly once)`);
	return text.replace(find, repl);
};
mkdirSync(out, { recursive: true });
for (const m of MUTANTS.filter((x) => !only || only.includes(x.id))) {
	const dir = join(out, m.id);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const t0 = performance.now();
	const args = [join(REPO, 'scripts', 'parity', 'run.mjs'), '--view', m.views, '--fixture-config', cfgFile, '--out', join(dir, 'out')];
	if (m.v5) {
		const html = join(dir, 'v5-copy.html');
		copyFileSync(cfg.mainHtml.path, html);
		let text = readFileSync(html, 'utf8');
		for (const [find, repl] of m.edits) text = replaceOnce(text, find, repl, 'v5 HTML');
		writeFileSync(html, text);
		args.push('--app-v5-html', html, '--no-exports');
	} else {
		const src = join(dir, 'src');
		mkdirSync(src);
		execFileSync('bash', ['-c', 'git -C "$0" archive --format=tar HEAD | tar -x -C "$1"', REPO, src]);
		for (const [file, find, repl] of m.edits) writeFileSync(join(src, file), replaceOnce(readFileSync(join(src, file), 'utf8'), find, repl, file));
		const cp = spawnSync('cp', ['-a', '--reflink=auto', join(REPO, 'node_modules'), join(src, 'node_modules')]);
		if (cp.status !== 0) die(`copying node_modules failed: ${cp.stderr}`);
		const b = spawnSync(process.execPath, ['run', '--bun', 'build'], { cwd: src, encoding: 'utf8', maxBuffer: 1 << 26 });
		if (b.status !== 0) die(`${m.id}: build failed:\n${(b.stdout + b.stderr).slice(-2000)}`);
		args.push('--app-root', src);
	}
	const r = run(args);
	const sc = existsSync(join(dir, 'out', 'scorecard.json')) ? JSON.parse(readFileSync(join(dir, 'out', 'scorecard.json'), 'utf8')) : null;
	const hits = [];
	for (const v of m.views.split(',')) {
		const f = join(dir, 'out', 'views', `${v}.json`);
		if (existsSync(f)) for (const d of JSON.parse(readFileSync(f, 'utf8')).unregistered) hits.push(d.path);
	}
	const caught = m.control ? r.status === 0 && hits.length === 0 : r.status === 1 && hits.some((p) => m.expect.test(p));
	results.push({ id: m.id, category: m.category, what: m.what, views: m.views, exit: r.status, unregistered: hits.length, matchingPaths: m.control ? 0 : hits.filter((p) => m.expect.test(p)).length, caught, seconds: Math.round((performance.now() - t0) / 1000), compared: sc?.total.compared ?? null });
	console.log(`${caught ? 'CAUGHT' : 'MISSED'} ${m.id.padEnd(17)} ${m.category.padEnd(17)} exit ${r.status} unregistered ${hits.length}${m.control ? ' (control)' : `, ${results.at(-1).matchingPaths} on ${m.expect}`} ${results.at(-1).seconds} s`);
	if (r.status === 2) console.error(r.stderr.slice(-1500));
	if (!argv.includes('--keep')) for (const x of ['src', 'v5-copy.html']) rmSync(join(dir, x), { recursive: true, force: true });
}
const ok = results.length > 0 && results.every((x) => x.caught);
writeFileSync(join(out, 'mutation-proof.json'), JSON.stringify({ ok, revision: execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), results }, null, 1) + '\n');
console.log(`mutate: ${ok ? 'PASS' : 'FAIL'}: ${results.filter((x) => x.caught).length}/${results.length} caught -> ${join(out, 'mutation-proof.json')}`);
process.exit(ok ? 0 : 1);
