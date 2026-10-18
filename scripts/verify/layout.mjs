#!/usr/bin/env bun
// Layout, navigation and contrast check of all 42 views (GRS-21, CC-11: BA-12, BA-13, BA-14, BA-18, BA-21), offline, on
// the production build (./build) under Bun:
//
//   bun scripts/verify/layout.mjs [--case synthetic|v5] [--out DIR] [--shots]
//
// --case synthetic (default) builds a synthetic case (tests/e2e/pilot/lib/fixtures.ts); --case v5 imports the real v5
// sample named by .local/v5-verification.json (case material: write --out under .local/ only). The script re-execs
// itself in a network namespace with only lo (tests/e2e/pilot/v5/env.mjs ensureOffline). For each registry view:
//   widths    at 320, 390, 768 and 1280 px: the page does not scroll sideways; no visible control overlaps the page heading
//             (BA-12); no two visible controls overlap (compared line box by line box, so a wrapped link is not
//             mistaken for an overlap); the smallest text size in main is recorded (BA-21 readability
//             at 320/390; reported, not gated: WCAG sets no minimum size);
//   label     the page heading is the one the analysis-additions state expects (viewHeading: the registry label, or v5's heading on
//             Timeline, Defence & Rebuttal and Info Required while CLEARCASE_ANALYSIS_ADDITIONS is not 1; ADR 0003), and the title and
//             the navigation entry start with the label (BA-18). The state comes from CLEARCASE_ANALYSIS_ADDITIONS on this process,
//             is passed to the launched app and recorded as analysisAdditions in layout.json;
//   keyboard  at 1280 px: the navigation link focused by keyboard and activated with Enter opens the view with focus on its
//             heading and aria-current on the link; Back returns to the previous view with focus inside the page (BA-14);
//   contrast  every visible element with its own text in main, against its effective background: 4.5:1, or 3:1 for
//             large text (WCAG 2.2 1.4.3; disabled controls are exempt), at 1280 px (BA-13); the shared navigation and top bar are checked on every
//             view and reported once, as the shell's. A gradient is measured stop by stop, each composited over the layers beneath,
//             and the worst stop counts; a gradient with its own background-size or no repeat counts the layers without it too
//             (layout-color.mjs);
// and once, the shared components (navigation link, button, link, input, table header) in their default, :hover,
// :focus-visible and :active states (CDP CSS.forcePseudoState): text contrast in each state, and a visible focus indicator
// with 3:1 against the background (WCAG 2.2 1.4.11, 2.4.7); an element that cannot take focus has no focus check. --shots saves one viewport PNG per view and width under
// DIR/shots/ and lists each with its sha256. Results: DIR/layout.json (default .local/GRS-21/layout-<case>) and one line
// per failing check. Exit 0 when every check passed, 1 if any failed, 2 on a setup error.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureOffline, PORTS } from '../../tests/e2e/pilot/v5/env.mjs';
import { COMPONENTS, WIDTHS } from './layout-spec.mjs';
import { COLOR } from './layout-color.mjs';
import { analysisAdditionsFrom, labelCheck, serverEnv } from './layout-label.mjs';
import { revisionStamp } from './stamp.mjs';

ensureOffline(import.meta.filename);
const { proveOffline } = await import('../../tests/e2e/pilot/lib/netproof.mjs');
const { launch, sleep } = await import('../../tests/e2e/pilot/lib/cdp.mjs');
const { INIT, openPage } = await import('../../tests/e2e/pilot/suite/browser.mjs');
const { appServer } = await import('../../tests/e2e/pilot/suite/context.mjs');
const { buildCase } = await import('../../tests/e2e/pilot/lib/fixtures.ts');
const { VIEWS } = await import('../../src/lib/components/view-registry.ts');

const ROOT = resolve(import.meta.dirname, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const CASE = arg('--case', 'synthetic');
const OUT = resolve(arg('--out', join(ROOT, '.local', 'GRS-21', `layout-${CASE}`)));
const SHOTS = process.argv.includes('--shots');
// the analysis-additions state of this run (ADR 0003, GRS-48): CLEARCASE_ANALYSIS_ADDITIONS=1 on the calling process, else off; recorded in layout.json
const ADDITIONS = analysisAdditionsFrom(process.env);
if (!['synthetic', 'v5'].includes(CASE)) { console.error('--case synthetic|v5'); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const J = JSON.stringify;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const ready = (id) => `document.querySelector('main#main')?.dataset.ready === ${J(id)}`;

// ---- in-page measurements --------------------------------------------------------------------------------------------


/**
 * Layout at the requested width `w`: sideways scroll, controls over the heading, overlapping controls, smallest text.
 * Sideways scroll is judged against `w`, not innerWidth: under mobile emulation Chrome widens the layout viewport to fit
 * content that overflows, so innerWidth grows with the overflow and would always agree with scrollWidth.
 */
const LAYOUT = (w) => `(() => { ${COLOR}
	const se = document.scrollingElement;
	const h = document.querySelector('[data-page-heading]');
	const hr = h?.getBoundingClientRect();
	const main = document.querySelector('main#main');
	// every visible control, however many: a cap would leave the rest unchecked and still pass
	const controls = [...(main?.querySelectorAll('a[href], button, select, input:not([type=hidden]), textarea, summary') ?? [])].filter(VIS);
	const hit = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
	const onHeading = h ? controls.filter((c) => !h.contains(c) && hit(c.getBoundingClientRect(), hr) > 4).map(label) : [];
	// each control's line boxes (getClientRects): a link that wraps has a bounding box over both lines, its boxes do not
	const rects = controls.map((c) => [c, [...c.getClientRects()].filter((r) => r.width > 0 && r.height > 0), c.getBoundingClientRect()]);
	const overlaps = [];
	for (let i = 0; i < rects.length && overlaps.length < 10; i++) for (let j = i + 1; j < rects.length; j++) {
		const [a, ra, ba] = rects[i], [b, rb, bb] = rects[j];
		if (hit(ba, bb) <= 4) continue; // line boxes lie inside the bounding box, so they cannot overlap by more
		if (a.contains(b) || b.contains(a)) continue;
		if (ra.some((x) => rb.some((y) => hit(x, y) > 4))) { overlaps.push(label(a) + ' / ' + label(b)); if (overlaps.length >= 10) break; }
	}
	const texts = [...(main?.querySelectorAll('*') ?? [])].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && VIS(e));
	const minFont = texts.length ? Math.min(...texts.map((e) => parseFloat(getComputedStyle(e).fontSize))) : null;
	// the widest visible elements past the requested width, so a failure names what pushes the page out
	const wide = Math.max(se.scrollWidth, innerWidth) > ${w} + 1 ? [...document.querySelectorAll('body *')].filter((e) => VIS(e) && e.getBoundingClientRect().right > ${w} + 1).slice(0, 6).map((e) => label(e) + ' ' + Math.round(e.getBoundingClientRect().right)) : [];
	return { requested: ${w}, controls: controls.length, innerWidth, scrollWidth: se.scrollWidth, sideways: Math.max(se.scrollWidth, innerWidth) > ${w} + 1, wide, heading: h?.textContent.trim() ?? null, onHeading, overlaps, minFont };
})()`;

/** Text contrast of every visible element with its own text, in main and in the shared navigation, counted apart. */
const CONTRAST = `(() => { ${COLOR}
	const scan = (sel, cap) => {
		// a disabled control is exempt (WCAG 2.2 1.4.3: inactive user interface components)
		const els = [...document.querySelectorAll(sel)].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && VIS(e) && !e.closest(':disabled, [aria-disabled="true"]'));
		const fails = [];
		let checked = 0, unparsed = 0, min = Infinity;
		for (const e of els) {
			const s = getComputedStyle(e);
			const fg = rgba(s.color); if (!fg) { unparsed++; continue; }
			const bg = bgOf(e, fg);
			const r = ratio(over(fg, bg), bg);
			const need = large(s) ? 3 : 4.5;
			checked++; min = Math.min(min, r);
			if (r + 1e-6 < need) fails.push({ el: label(e), text: e.textContent.trim().slice(0, 40), ratio: +r.toFixed(2), need, fg: s.color, bg: 'rgb(' + [bg.r, bg.g, bg.b].map(Math.round).join(', ') + ')' });
		}
		return { checked, unparsed, min: checked ? +min.toFixed(2) : null, fails: fails.slice(0, cap), failCount: fails.length };
	};
	// the navigation list is not capped: every failing link is reported once below, whatever the page
	return { main: scan('main#main *', 20), nav: scan('nav *, header.top *', Infinity) };
})()`;

// ---- run -----------------------------------------------------------------------------------------------------------

const offline = await proveOffline();
if (!offline.pass) { console.error('layout: not offline'); process.exit(2); }
const tmp = mkdtempSync(join(tmpdir(), 'cc-verify-layout-'));
const A = appServer({ name: 'layout', root: ROOT, buildDir: join(ROOT, 'build'), port: PORTS.first, origPort: PORTS.first + 1, dir: tmp, env: serverEnv(ADDITIONS) });
const out = { case: CASE, analysisAdditions: ADDITIONS, revision: revisionStamp(ROOT), widths: WIDTHS, views: [], shellContrast: {}, components: [], shots: [], failures: [] };
const fail = (what) => { out.failures.push(what); console.log(`FAIL ${what}`); };
let b, p, code = 2;
try {
	await A.start();
	let caseDir, pkgDir;
	if (CASE === 'v5') {
		const { loadConfig, v5Package } = await import('../../tests/e2e/pilot/v5/fixture.mjs');
		const fx = await loadConfig();
		const pkg = v5Package(fx, join(tmp, 'v5-package'));
		caseDir = fx.caseFolder; pkgDir = pkg.dir;
	} else {
		const sc = await buildCase(join(tmp, 'case'), { caseId: 'verify-layout' });
		caseDir = sc.caseDir; pkgDir = sc.pkgDir;
	}
	const imp = await A.c.importPkg(caseDir, pkgDir);
	await A.c.activate(imp.importId);
	const rv = await A.c.activeVersion();
	if (!rv) throw new Error(`activation failed: ${J({ status: imp.status })}`);
	b = await launch({ profileRoot: join(tmp, 'chromium') });
	p = await openPage(b, { initScript: INIT });
	const setWidth = (w) => p.s('Emulation.setDeviceMetricsOverride', { width: w, height: w < 800 ? 800 : 900, deviceScaleFactor: 1, mobile: w < 800 });
	const settle = () => p.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
	const shotsDir = join(OUT, 'shots');
	if (SHOTS) mkdirSync(shotsDir, { recursive: true });

	let prev = 'overview';
	for (const v of VIEWS) {
		const url = `${A.v(rv)}${v.route}`;
		const row = { view: v.id, label: v.label, widths: {} };
		for (const w of WIDTHS) {
			await setWidth(w);
			await p.goto(url, ready(v.id), 30000);
			await settle();
			const m = await p.evaluate(LAYOUT(w));
			row.widths[w] = m;
			if (m.sideways) fail(`${v.id}@${w}: scrolls sideways (content ${m.scrollWidth}, layout viewport ${m.innerWidth}, requested ${w}; past it: ${m.wide.join(', ') || 'none'})`);
			if (m.onHeading.length) fail(`${v.id}@${w}: controls over the heading: ${m.onHeading.join(', ')}`);
			if (m.overlaps.length) fail(`${v.id}@${w}: overlapping controls: ${m.overlaps.slice(0, 3).join('; ')}`);
			if (SHOTS) {
				const { data } = await p.s('Page.captureScreenshot', { format: 'png' });
				const buf = Buffer.from(data, 'base64');
				const file = join(shotsDir, `${v.id}@${w}.png`);
				writeFileSync(file, buf);
				out.shots.push({ view: v.id, width: w, file: file.slice(ROOT.length + 1), sha256: sha(buf), bytes: buf.length });
			}
		}
		// label and title (BA-18), then contrast at 1280 (BA-13)
		const id = await p.evaluate(`({ heading: document.querySelector('[data-page-heading]')?.textContent.trim() ?? null, title: document.title, nav: document.querySelector('#nav-${v.id}')?.textContent.trim() ?? null })`);
		row.label = { ...id, ...labelCheck(v, id, ADDITIONS) };
		if (!row.label.ok) fail(`${v.id}: label ${J(v.label)}, expected heading ${J(row.label.expected)} (analysis additions ${ADDITIONS ? 'on' : 'off'}) vs heading ${J(id.heading)}, title ${J(id.title)}, nav ${J(id.nav)}`);
		row.contrast = await p.evaluate(CONTRAST);
		const cm = row.contrast.main, cn = row.contrast.nav;
		if (cm.unparsed || cn.unparsed) fail(`${v.id}: ${cm.unparsed + cn.unparsed} elements with a text colour the contrast check cannot parse`);
		if (cm.failCount) fail(`${v.id}: ${cm.failCount} text elements in main under their contrast minimum (lowest ${cm.min}): ${cm.fails.slice(0, 3).map((f) => `${f.el} ${f.ratio}`).join(', ')}`);
		// the shared navigation is the same on every page: counted per view, reported once below
		for (const f of cn.fails) (out.shellContrast[`${f.el} ${f.ratio}`] ??= { ...f, views: [] }).views.push(v.id);
		// keyboard navigation and Back (BA-14), from the previous view
		if (prev === v.id) prev = 'chronology';
		await p.goto(`${A.v(rv)}${VIEWS.find((x) => x.id === prev).route}`, ready(prev), 30000);
		await p.evaluate(`document.querySelector('#nav-${v.id}').focus(); true`);
		await p.key('Enter');
		await p.waitFor(ready(v.id), 20000).catch(() => {});
		await sleep(120);
		const nav = await p.evaluate(`({ ready: document.querySelector('main#main')?.dataset.ready ?? null, focus: document.activeElement?.hasAttribute('data-page-heading') ?? false, current: document.querySelector('a[data-view][aria-current="page"]')?.id ?? null })`);
		await p.evaluate('history.back(); true');
		await p.waitFor(ready(prev), 20000).catch(() => {});
		await sleep(200);
		const back = await p.evaluate(`({ ready: document.querySelector('main#main')?.dataset.ready ?? null, body: document.activeElement === document.body, inMain: !!document.activeElement?.closest('main#main') })`);
		row.keyboard = { nav, back, ok: nav.ready === v.id && nav.focus && nav.current === `nav-${v.id}` && back.ready === prev && back.inMain };
		if (!row.keyboard.ok) fail(`${v.id}: keyboard ${J(nav)} back ${J(back)}`);
		prev = v.id;
		out.views.push(row);
		console.log(`view ${v.id}: ${Object.values(row.widths).every((m) => !m.sideways && !m.onHeading.length && !m.overlaps.length) ? 'layout ok' : 'LAYOUT'}, label ${row.label.ok ? 'ok' : 'FAIL'}, keyboard ${row.keyboard.ok ? 'ok' : 'FAIL'}, contrast ${cm.failCount ? 'FAIL' : 'ok'} (${cm.checked} in main, ${cn.failCount} under the minimum in the navigation)`);
	}

	const shell = Object.values(out.shellContrast);
	if (shell.length) fail(`shell navigation: ${shell.length} text elements under their contrast minimum: ${shell.slice(0, 3).map((f) => `${f.el} ${f.ratio} (${f.fg} on ${f.bg}, ${f.views.length} views)`).join(', ')}`);

	// shared components in their interaction states (BA-13)
	await p.s('DOM.enable');
	await p.s('CSS.enable');
	await setWidth(1280);
	for (const [name, view, sel] of COMPONENTS) {
		const v = VIEWS.find((x) => x.id === view);
		await p.goto(`${A.v(rv)}${v.route}`, ready(view), 30000);
		const has = await p.evaluate(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return false; e.setAttribute('data-verify-target', '1'); e.scrollIntoView({ block: 'center' }); return true; })()`);
		if (!has) { fail(`component ${name}: none on ${view}`); continue; }
		const { root } = await p.s('DOM.getDocument', { depth: 0 });
		const { nodeId } = await p.s('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-verify-target="1"]' });
		const states = {};
		for (const state of ['default', 'hover', 'focus-visible', 'active']) {
			await p.s('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: state === 'default' ? [] : state === 'focus-visible' ? ['focus', 'focus-visible'] : [state] });
			if (state === 'focus-visible') await p.evaluate(`document.querySelector('[data-verify-target="1"]').focus(); true`);
			await settle();
			states[state] = await p.evaluate(`(() => { ${COLOR}
				const e = document.querySelector('[data-verify-target="1"]'); const s = getComputedStyle(e); const fg = rgba(s.color); const bg = bgOf(e, fg);
				const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 1 ? rgba(s.outlineColor) : null;
				const shadow = s.boxShadow && s.boxShadow !== 'none' ? rgba(s.boxShadow) : null;
				const ring = outline ?? shadow;
				const outerBg = bgOf(e.parentElement ?? e);
				return { text: fg ? +ratio(over(fg, bg), bg).toFixed(2) : null, large: large(s), outline: s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineColor, boxShadow: s.boxShadow.slice(0, 60), ring: ring ? +ratio(over(ring, outerBg), outerBg).toFixed(2) : null };
			})()`);
			if (state === 'focus-visible') await p.evaluate(`document.activeElement?.blur(); true`);
		}
		await p.s('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
		const need = states.default.large ? 3 : 4.5;
		const textOk = Object.values(states).every((s) => s.text !== null && s.text + 1e-6 >= need);
		// an element that cannot take focus (a table header) has no focus state to check
		const focusable = await p.evaluate(`(() => { const e = document.querySelector('[data-verify-target="1"]'); return e.tabIndex >= 0 || e.matches('a[href], button, input, select, textarea, summary'); })()`);
		const focusOk = focusable ? states['focus-visible'].ring !== null && states['focus-visible'].ring >= 3 : null;
		out.components.push({ name, view, selector: sel, states, textOk, focusable, focusOk });
		if (!textOk) fail(`component ${name}: text under ${need}:1 in a state: ${J(Object.fromEntries(Object.entries(states).map(([k, s]) => [k, s.text])))}`);
		if (focusOk === false) fail(`component ${name}: focus indicator ${J(states['focus-visible'])}`);
		console.log(`component ${name}: text ${textOk ? 'ok' : 'FAIL'}, focus ${focusOk === null ? 'n/a (not focusable)' : focusOk ? 'ok' : 'FAIL'}`);
	}
	code = out.failures.length ? 1 : 0;
} catch (e) {
	console.error(`layout: ${String(e?.stack ?? e).slice(0, 2000)}`);
	out.error = String(e?.message ?? e);
	code = 2;
} finally {
	await p?.close().catch(() => {});
	await b?.close().catch(() => {});
	await A.stop().catch(() => {});
	out.exit = code;
	writeFileSync(join(OUT, 'layout.json'), J(out, null, 1));
	rmSync(tmp, { recursive: true, force: true });
}
console.log(`layout: ${code === 0 ? 'PASS' : 'FAIL'} (exit ${code}): ${out.views.length} views x ${WIDTHS.length} widths, ${out.components.length} components, ${out.failures.length} failures -> ${join(OUT, 'layout.json')}`);
process.exit(code);
