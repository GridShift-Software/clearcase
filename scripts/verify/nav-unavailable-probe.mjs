#!/usr/bin/env bun
// Probe: the current link of an unavailable view keeps its contrast (GRS-67, M3). src/app.css gives
// `a.unavailable` grey text and `a[aria-current='page']` a navy background with the same specificity, so without a rule
// for both together the grey wins on navy. No committed view stays unavailable, so this renders the markup of
// ViewNav.svelte for one unavailable view that is current, one that is not, and one available current view, with the
// real src/app.css, in the real browser, and checks the text against its background (4.5:1).
//
//   bun scripts/verify/nav-unavailable-probe.mjs            run through orch-bin/browser-lock, like any browser job
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch, newPage } from '../../tests/e2e/pilot/lib/cdp.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'cc-nav-probe-'));
const nav = `<nav class="views" aria-label="Case views"><section><h2>Group</h2><ul>
	<li><a href="#a" id="available-current" aria-current="page">Available, current</a></li>
	<li><a href="#b" id="unavailable-current" aria-current="page" class="unavailable">Unavailable, current<span class="visually-hidden"> (not yet available)</span></a></li>
	<li><a href="#c" id="unavailable" class="unavailable">Unavailable</a></li>
	<li><a href="#d" id="available">Available</a></li>
</ul></section></nav>`;
writeFileSync(join(tmp, 'nav.html'), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(join(ROOT, 'src', 'app.css'))}"><body>${nav}</body>`);

const MEASURE = `(() => {
	const rgb = (s) => s.match(/[\\d.]+/g).map(Number);
	const lum = ([r, g, b]) => { const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
	const bgOf = (e) => { for (; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c[3] === undefined || c[3] > 0) return c; } return [255, 255, 255]; };
	return [...document.querySelectorAll('nav.views a')].map((a) => {
		const fg = rgb(getComputedStyle(a).color), bg = bgOf(a), [x, y] = [lum(fg), lum(bg)];
		return { id: a.id, color: getComputedStyle(a).color, background: getComputedStyle(a).backgroundColor, ratio: +((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2) };
	});
})()`;

let b, code = 1;
try {
	b = await launch({ profileRoot: join(tmp, 'chromium') });
	const p = await newPage(b);
	const r = await p.navigate(pathToFileURL(join(tmp, 'nav.html')).href);
	if (r.errorText) throw new Error(`navigate: ${r.errorText}`);
	await p.waitFor('document.readyState === "complete"', 10000);
	const rows = await p.evaluate(MEASURE);
	for (const x of rows) console.log(`${x.id}: ${x.color} on ${x.background} = ${x.ratio}:1`);
	const bad = rows.filter((x) => x.ratio < 4.5);
	console.log(bad.length ? `FAIL ${bad.map((x) => x.id).join(', ')} under 4.5:1` : `PASS ${rows.length} links, lowest ${Math.min(...rows.map((x) => x.ratio))}:1`);
	code = bad.length ? 1 : 0;
} finally {
	await b?.close?.();
	rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);
