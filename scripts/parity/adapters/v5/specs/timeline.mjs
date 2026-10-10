// Timeline (GRS-15): every phase and every event row in order. The generic extraction compares the phase notes and
// counts the event links by label; this sweep compares each event's date, kind, ref, title, note and whether it is a
// link, phase by phase (scenario 3, "read the timeline in order"). Keys are positions, never case text.
// v5 escapes event titles twice (S-double-escape), so its labels show entities such as `&amp;`. The v5 side's titles
// and link labels are unescaped once before comparing, so the app's must equal the unescaped v5 value exactly; each
// event's `escaped` value ('twice' when the label shows an entity, else 'once') records the difference itself.
// The timeline_print sweep compares what Print / PDF prints from the page heading on (both shells left out), with the
// v5 side unescaped once in the same way.
const readPhases = `[...document.querySelectorAll('#main .tl .ph')].map((ph) => ({
	label: ph.querySelector('.yr')?.textContent.trim() ?? '',
	title: ph.querySelector('h3, h4')?.textContent.trim() ?? '',
	events: [...ph.querySelectorAll('.ev')].filter((e) => e.querySelector('.d')).map((e) => {
		const a = e.querySelector('a');
		const t = (s) => (s?.textContent ?? '').replace(/\\s+/g, ' ').trim();
		const label = a ? t(a) : [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').replace(/^[\\s·]+/, '').trim();
		return { date: t(e.querySelector('.d')), kind: t(e.querySelector('.badge')), ref: t(e.querySelector('.mono')), title: label.replace(/\\s*↗$/, ''), note: t(e.querySelector('.ex')), link: a ? 'link' : e.querySelector('.cite-broken') ? 'broken' : 'text' };
	}),
	empty: ph.querySelectorAll('.ev').length > 0 && ![...ph.querySelectorAll('.ev')].some((e) => e.querySelector('.d')),
}))`;

const ENTITY = /&(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-f]+);/gi;
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** HTML entities decoded once (what v5 meant to show when it escaped a value twice). */
export const unescapeOnce = (s) => String(s).replace(ENTITY, (_, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : NAMED[e.toLowerCase()]));
const shownEscaped = (s) => (new RegExp(ENTITY.source, 'i').test(s) ? 'twice' : 'once');

/**
 * The sweep's values from one side's phases: per phase its label, title and event count; per event each field and
 * whether its label shows an entity. `unescape` (the v5 side) decodes the titles once.
 */
export function eventValues(phases, { unescape = false } = {}) {
	const out = { phases: String(phases.length) };
	phases.forEach((ph, i) => {
		out[`p${i}.label`] = ph.label;
		out[`p${i}.title`] = ph.title;
		out[`p${i}.events`] = String(ph.events.length);
		out[`p${i}.empty`] = String(ph.empty);
		ph.events.forEach((e, j) => {
			for (const k of ['date', 'kind', 'ref', 'title', 'note', 'link']) out[`p${i}.e${j}.${k}`] = k === 'title' && unescape ? unescapeOnce(e[k]) : e[k];
			out[`p${i}.e${j}.escaped`] = shownEscaped(e.title);
		});
	});
	return out;
}
export const PHASES_JS = readPhases;

/** The page's main text and its heading, whitespace collapsed, to find the content in a print capture. */
export const MAIN_JS = `(() => { const n = (s) => (s ?? '').replace(/\\s+/g, ' ').trim(); const m = document.querySelector('#main'); return { main: n(m?.innerText), heading: n(m?.querySelector('h1, h2')?.innerText) }; })()`;
const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** A print capture (the page's whole text) from the start of the page's main on, or null when main is not in it. */
export function fromMain(printText, { main }) {
	const t = collapse(printText);
	const at = main ? t.indexOf(main.slice(0, 80)) : -1;
	return at < 0 ? null : t.slice(at);
}
/** The sweep's values of one Print / PDF press: how many prints, and the printed text after the page heading. */
export function printValues(print, page, { unescape = false } = {}) {
	const m = print.prints ? fromMain(print.text, page) : null;
	const content = m === null ? '(main not in the print capture)' : page.heading && m.startsWith(page.heading) ? m.slice(page.heading.length).trim() : `(no heading) ${m}`;
	return { prints: String(print.prints), content: unescape ? unescapeOnce(content) : content };
}
/** v5's Print / PDF control: the first visible top-level control of the view whose label names printing. */
const PRESS_PRINT_JS = `(() => { const e = [...document.querySelectorAll('#main button, #main [role=button]')].find((e) => e.getClientRects().length && !e.closest('tbody tr') && /print/i.test(e.innerText)); if (!e) return false; e.setAttribute('data-parity-press', '1'); return true; })()`;

export default {
	postRaw(raw) { for (const c of raw.controls ?? []) if (typeof c.label === 'string') c.label = unescapeOnce(c.label); },
	sweeps: [{
		id: 'timeline_events',
		async v5(p) {
			await p.load({});
			await p.go('timeline');
			return eventValues(await p.evaluate(readPhases), { unescape: true });
		},
	}, {
		id: 'timeline_print',
		async v5(p) {
			await p.load({});
			await p.go('timeline');
			await p.takePrint();
			if (await p.evaluate(PRESS_PRINT_JS)) await p.click('[data-parity-press]');
			await new Promise((r) => setTimeout(r, 60));
			const print = await p.takePrint();
			return printValues(print, await p.evaluate(MAIN_JS), { unescape: true });
		},
	}],
};
