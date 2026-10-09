// What the tree under test implements, so the pilot checks (main-flow.mjs, v5/lanes.mjs) assert each M2 view and
// overview slot in the mode it is in, and do not break when an owner adds its first route or fills its first slot:
//   a view is implemented when src/routes/v/[vid]/<category>/<view-id>/+page.svelte exists (its registry route);
//   a slot is filled when its owner's src/lib/views/<category>/overview-widgets.ts names it (`slot: '<slot-id>'`).
// Everything else keeps the unavailable assertions. Read from the files, never from the registry status, which flips
// only after the owner's gate.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The generated view registry and the overview slot declaration of the tree at `root`. */
export async function registryOf(root) {
	const { VIEWS } = await import(join(root, 'src', 'lib', 'components', 'view-registry.ts'));
	const { OVERVIEW_SLOTS } = await import(join(root, 'src', 'lib', 'components', 'overview-slots.ts'));
	return { views: VIEWS, slots: OVERVIEW_SLOTS };
}

/** The owner route file of a registry view, or null for the pilot's own views (category null). */
export const routeFile = (root, v) => (v.category ? join(root, 'src', 'routes', 'v', '[vid]', ...v.route.split('/').filter(Boolean), '+page.svelte') : null);

/** Ids of the M2 views whose owner route exists under `root`. */
export const implementedViews = (root, views) => new Set(views.filter((v) => { const f = routeFile(root, v); return f !== null && existsSync(f); }).map((v) => v.id));

/** Ids of the overview slots their owner's overview-widgets.ts fills under `root`. */
export function filledSlots(root, slots) {
	const out = new Set();
	for (const s of slots) {
		const f = join(root, 'src', 'lib', 'views', s.category, 'overview-widgets.ts');
		if (!existsSync(f)) continue;
		const src = readFileSync(f, 'utf8');
		if (new RegExp(`\\bslot\\s*:\\s*(['"\`])${s.id.replace(/[-]/g, '\\-')}\\1`).test(src)) out.add(s.id);
	}
	return out;
}

/** The first registry view (in registry order) that has an owner but no owner route yet, or null: 'none left'. */
export const firstUnimplemented = (views, implemented) => views.find((v) => v.category && !implemented.has(v.id)) ?? null;

/** The ready marker a destination sets: the pilot's own views their name, an implemented view its id, else view:<id>. */
export const readyKind = (v, implemented) => (v.category === null ? v.id : implemented.has(v.id) ? v.id : `view:${v.id}`);

/**
 * Whether one observed destination (`s`: h1, ready, unavailable, owner, text, current; `navStatus`: the nav entry's
 * data-status) is what its mode requires. `owner` is the owning Linear id, null for the pilot's views.
 */
export function destinationOk(v, s, { owner, implemented, navStatus }) {
	const base = s.h1 === v.label && s.ready === readyKind(v, implemented) && s.current === `nav-${v.id}`;
	if (!owner) return base && s.unavailable === null && navStatus === 'available';
	if (implemented.has(v.id)) return base && s.unavailable === null;
	return base && s.unavailable === v.id && s.owner === owner && (s.text ?? '').includes(owner) && navStatus === `unavailable-until:${owner}`;
}

/** The expected state of one overview slot: filled needs status and heading; unfilled keeps the owner wording. */
export const expectedSlot = (s, filled) => (filled.has(s.id) ? { id: s.id, status: 'filled', heading: s.title } : { id: s.id, status: 'unavailable', heading: s.title, text: `Not yet available — owned by ${s.linear} (${s.owner}).` });

/** An observed slot ({id, status, heading, text}) reduced to the fields its mode compares. */
export const observedSlot = (o, filled) => (filled.has(o.id) ? { id: o.id, status: o.status, heading: o.heading } : { id: o.id, status: o.status, heading: o.heading, text: o.text });

/** One summary for the evidence: which views and slots the run treated as implemented. */
export const modeSummary = (views, implemented, filled) => ({ implemented: views.filter((v) => implemented.has(v.id)).map((v) => v.id), filledSlots: [...filled], example: firstUnimplemented(views, implemented)?.id ?? 'none left' });

/** The server-rendered overview slots ({id, status, heading, text}; text is the first <p> after the heading, or null). */
export const slotsFromHtml = (html, decode = (x) => x) => [...html.matchAll(/<section class="card" aria-labelledby="slot-([a-z-]+)" data-slot="([a-z-]+)" data-slot-status="([a-z]+)">\s*<h2 id="slot-[a-z-]+">([^<]*)<\/h2>\s*(?:<!--[^>]*-->)*\s*(?:<p>([^<]*)<\/p>)?/g)]
	.map((m) => ({ id: m[2], status: m[3], heading: decode(m[4]), text: m[5] === undefined ? null : decode(m[5]) }));
