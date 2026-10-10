// The pilot checks' implementation awareness (lib/implemented.mjs): in a scratch copy of the tree, a temporary owner
// route and a filled overview slot switch the views42/titles/keyboard/slots and checkRegistry/checkSlots expectations
// from unavailable to implemented, and back when they are removed. Nothing is written into the repository, and the
// committed tree is checked against its own routes, so the test holds whichever M2 views exist.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { destinationOk, expectedSlot, filledSlots, firstUnimplemented, implementedViews, observedSlot, readyKind, registryOf, routeFile, slotsFromHtml } from './implemented.mjs';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');
const tree = mkdtempSync(join(tmpdir(), 'cc-implemented-'));
afterAll(() => rmSync(tree, { recursive: true, force: true }));
const put = (p: string, s: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, s); };
for (const f of ['view-registry.ts', 'overview-slots.ts']) put(join(tree, 'src', 'lib', 'components', f), readFileSync(join(REPO, 'src', 'lib', 'components', f), 'utf8'));
const { views, slots } = await registryOf(tree);
const byId = (id: string) => views.find((v: { id: string }) => v.id === id)!;
const widgets = join(tree, 'src', 'lib', 'views', 'registers', 'overview-widgets.ts');

// what the browser reads on a destination, in each mode
const unavailable = (v: { id: string; label: string; linear: string }) => ({ h1: v.label, ready: `view:${v.id}`, unavailable: v.id, owner: v.linear, text: `Not yet available — owned by ${v.linear}`, current: `nav-${v.id}` });
const built = (v: { id: string; label: string }) => ({ h1: v.label, ready: v.id, unavailable: null, owner: null, text: null, current: `nav-${v.id}` });
const slotHtml = (id: string, title: string, status: string, body: string) => `<section class="card" aria-labelledby="slot-${id}" data-slot="${id}" data-slot-status="${status}"><h2 id="slot-${id}">${title}</h2><!--[-->${body}</section>`;

describe('pilot checks follow the tree under test', () => {
	test('the committed tree, whatever its owners have added: a view is implemented exactly when its route is on disk', () => {
		// read the routes from disk, not through routeFile: each +page.svelte under src/routes/v/[vid]/, as a registry route
		const base = join(REPO, 'src', 'routes', 'v', '[vid]');
		const onDisk = new Set((readdirSync(base, { recursive: true }) as string[]).filter((f) => basename(f) === '+page.svelte').map((f) => `/${dirname(f).split(sep).join('/')}`));
		const want = new Set(views.filter((v: { category: string | null; route: string }) => v.category && onDisk.has(v.route)).map((v: { id: string }) => v.id));
		const impl = implementedViews(REPO, views);
		expect(impl).toEqual(want);
		expect(firstUnimplemented(views, impl)?.id ?? null).toBe(views.find((v: { id: string; category: string | null }) => v.category && !want.has(v.id))?.id ?? null);
		// a filled slot is named by its owner's overview-widgets.ts, which must exist
		for (const id of filledSlots(REPO, slots)) expect(existsSync(join(REPO, 'src', 'lib', 'views', slots.find((x: { id: string }) => x.id === id)!.category, 'overview-widgets.ts')), id).toBe(true);
	});

	test('a tree with no owner route and no filled slot: every M2 view and slot is unavailable, and the example is matter', () => {
		expect(implementedViews(tree, views).size).toBe(0);
		expect(filledSlots(tree, slots).size).toBe(0);
		expect(firstUnimplemented(views, implementedViews(tree, views))?.id).toBe('matter');
	});

	test('a temporary owner route and filled slot switch the checks to implemented mode; removing them switches back', () => {
		const tl = byId('timeline');
		const none = new Set<string>();
		// before: timeline is unavailable and must look unavailable
		expect(implementedViews(tree, views)).toEqual(none);
		expect(readyKind(tl, none)).toBe('view:timeline');
		expect(destinationOk(tl, unavailable(tl), { owner: tl.linear, implemented: none, navStatus: tl.status })).toBe(true);
		expect(destinationOk(tl, built(tl), { owner: tl.linear, implemented: none, navStatus: tl.status })).toBe(false);
		expect(expectedSlot(slots[0], filledSlots(tree, slots))).toEqual({ id: 'deadlines', status: 'unavailable', heading: 'Open deadlines', text: 'Not yet available — owned by GRS-17 (CC-07).' });

		put(routeFile(tree, tl)!, '<main id="main" data-ready="timeline"></main>\n');
		put(widgets, "import W from './Deadlines.svelte';\nexport const widgets = [{ slot: 'deadlines', component: W }];\n");
		const impl = implementedViews(tree, views);
		const filled = filledSlots(tree, slots);
		expect([...impl]).toEqual(['timeline']);
		expect([...filled]).toEqual(['deadlines']);
		// the implemented view must render as implemented, and the placeholder no longer passes for it
		expect(readyKind(tl, impl)).toBe('timeline');
		expect(destinationOk(tl, built(tl), { owner: tl.linear, implemented: impl, navStatus: tl.status })).toBe(true);
		expect(destinationOk(tl, unavailable(tl), { owner: tl.linear, implemented: impl, navStatus: tl.status })).toBe(false);
		expect(destinationOk(tl, { ...built(tl), current: null }, { owner: tl.linear, implemented: impl, navStatus: tl.status })).toBe(false);
		expect(destinationOk(tl, { ...built(tl), h1: 'Something else' }, { owner: tl.linear, implemented: impl, navStatus: tl.status })).toBe(false);
		// other views keep the unavailable assertion, and the example is still the first view without a route
		const mt = byId('matter');
		expect(destinationOk(mt, unavailable(mt), { owner: mt.linear, implemented: impl, navStatus: mt.status })).toBe(true);
		expect(destinationOk(mt, built(mt), { owner: mt.linear, implemented: impl, navStatus: mt.status })).toBe(false);
		expect(firstUnimplemented(views, impl)?.id).toBe('matter');
		// filled slot: status and heading; its siblings keep the owner wording
		const html = slotHtml('deadlines', 'Open deadlines', 'filled', '<div class="num">3</div>') + slotHtml('unbilled-time', 'Unbilled time', 'unavailable', '<p>Not yet available — owned by GRS-17 (CC-07).</p>') + slotHtml('rescan-freshness', 'Freshness', 'unavailable', '<p>Not yet available — owned by GRS-20 (CC-10).</p>');
		expect(slotsFromHtml(html).map((o) => observedSlot(o, filled))).toEqual(slots.map((s: (typeof slots)[number]) => expectedSlot(s, filled)));
		expect(slotsFromHtml(html).map((o) => observedSlot(o, new Set()))).not.toEqual(slots.map((s: (typeof slots)[number]) => expectedSlot(s, new Set())));
		const unfilledHtml = html.replace('data-slot-status="filled"><h2 id="slot-deadlines">Open deadlines</h2><!--[--><div class="num">3</div>', 'data-slot-status="unavailable"><h2 id="slot-deadlines">Open deadlines</h2><!--[--><p>Not yet available — owned by GRS-17 (CC-07).</p>');
		expect(slotsFromHtml(unfilledHtml).map((o) => observedSlot(o, filled))).not.toEqual(slots.map((s: (typeof slots)[number]) => expectedSlot(s, filled)));
		expect(slotsFromHtml(unfilledHtml).map((o) => observedSlot(o, new Set()))).toEqual(slots.map((s: (typeof slots)[number]) => expectedSlot(s, new Set())));

		rmSync(routeFile(tree, tl)!);
		rmSync(widgets);
		expect(implementedViews(tree, views).size).toBe(0);
		expect(filledSlots(tree, slots).size).toBe(0);
	});

	test('a slot named only in a comment or under another id is not filled; the extension route is not an owner route', () => {
		put(widgets, "// slot: deadlines comes later\nexport const widgets = [{ slot: 'deadlines-extra', component: null }];\n");
		expect(filledSlots(tree, slots).size).toBe(0);
		rmSync(widgets);
		put(join(tree, 'src', 'routes', 'v', '[vid]', '[category]', '[view]', '+page.svelte'), '');
		expect(implementedViews(tree, views).size).toBe(0);
		expect(routeFile(tree, byId('overview'))).toBeNull();
	});

	test("when every M2 view has its route the example is 'none left' and every count is implemented", () => {
		for (const v of views) if (v.category) put(routeFile(tree, v)!, '');
		const impl = implementedViews(tree, views);
		expect(impl.size).toBe(40);
		expect(firstUnimplemented(views, impl)).toBeNull();
		for (const v of views) if (v.category) rmSync(routeFile(tree, v)!);
	});

	test('the pilot checks use these rules instead of assuming 40 unavailable views and unfilled slots', () => {
		const flow = readFileSync(join(REPO, 'tests', 'e2e', 'pilot', 'suite', 'main-flow.mjs'), 'utf8');
		const lanes = readFileSync(join(REPO, 'tests', 'e2e', 'pilot', 'v5', 'lanes.mjs'), 'utf8');
		expect(flow).not.toMatch(/'view:timeline'|&& unavailableCount === 40|s\.status === 'unavailable'/);
		expect(flow).toMatch(/implementedCount \+ unavailableCount === 40/);
		for (const f of ['destinationOk', 'expectedSlot', 'firstUnimplemented']) expect(flow).toContain(`${f}(`);
		for (const f of ['implementedViews(C.build.root', 'filledSlots(C.build.root', 'firstUnimplemented(', 'expectedSlot(s, filled)']) expect(lanes).toContain(f);
		expect(lanes).not.toContain("want.find((v) => v.status !== 'available')");
	});
});
