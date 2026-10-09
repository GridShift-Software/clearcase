// Timeline (GRS-15): every phase and every event row in order. The generic extraction compares the phase notes and
// counts the event links by label; this sweep compares each event's date, kind, ref, title, note and whether it is a
// link, phase by phase (scenario 3, "read the timeline in order"). Keys are positions, never case text.
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

/** The sweep's values from one side's phases: per phase its label, title and event count; per event each field. */
export function eventValues(phases) {
	const out = { phases: String(phases.length) };
	phases.forEach((ph, i) => {
		out[`p${i}.label`] = ph.label;
		out[`p${i}.title`] = ph.title;
		out[`p${i}.events`] = String(ph.events.length);
		out[`p${i}.empty`] = String(ph.empty);
		ph.events.forEach((e, j) => { for (const k of ['date', 'kind', 'ref', 'title', 'note', 'link']) out[`p${i}.e${j}.${k}`] = e[k]; });
	});
	return out;
}
export const PHASES_JS = readPhases;

export default {
	sweeps: [{
		id: 'timeline_events',
		async v5(p) {
			await p.load({});
			await p.go('timeline');
			return eventValues(await p.evaluate(readPhases));
		},
	}],
};
