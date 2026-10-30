import { afterAll, beforeAll, expect, test } from 'vitest';
import family from '../../../scripts/publish/shards/views-bundles';
import paths from '../../../scripts/publish/shards/bundle-paths';
import { bootCase, type Booted } from '../../registers/04-harness';
import {
	courtPure,
	discoveryPure,
	caselinesPure,
} from '../../../src/lib/views/bundles/pure.server';
import { bundleLinks } from '../../../src/lib/views/bundles/links.hosted';
let b: Booted;
beforeAll(async () => {
	b = await bootCase('18-bundles');
}, 180000);
afterAll(async () => {
	await b?.stop();
});
test('publishes three transformed view shards and a typed path index', async () => {
	const ctx = {
		caseId: b.caseId,
		resultsVersion: b.rv,
		store: b.lc.store,
		vc: b.input().vc,
		pure: b.input(),
		json: (name: string, data: unknown) => ({
			name,
			bytes: new TextEncoder().encode(JSON.stringify(data)),
		}),
	};
	const built = await family.build(ctx);
	expect(built.map((s) => s.name)).toEqual([
		'view/court_bundle_tab.json',
		'view/discovery_tab.json',
		'view/caselines_tab.json',
	]);
	const values = built.map((s) =>
		JSON.parse(new TextDecoder().decode(s.bytes)),
	);
	expect(values[0]).toEqual(courtPure(b.input()));
	expect(values[1]).toEqual(discoveryPure(b.input()));
	expect(values[2]).toEqual(caselinesPure(b.input()));
	const pathShard = JSON.parse(
		new TextDecoder().decode((await paths.build(ctx))[0]!.bytes),
	);
	expect(pathShard.paths).toEqual(values[0].pathShard.paths);
	const links = bundleLinks(pathShard, b.caseId);
	for (const [ref, href] of Object.entries(links.files))
		expect(href).toBe(
			`/cases/${b.caseId}/originals/${encodeURIComponent(ref)}/view`,
		);
	expect(values[0]).not.toHaveProperty('raw');
});
test('pure court props keep the local view contract with empty user work', async () => {
	const local =
		await import('../../../src/routes/v/[vid]/bundles/court_bundle_tab/+page.server');
	const expected = await b.load(local),
		{ pathShard, ...actual } = courtPure(b.input());
	const { downloads: localDownloads, ...localProps } = expected;
	const { downloads: shardDownloads, ...shardProps } = actual;
	expect({ ...shardProps, headerHash: expected.headerHash }).toEqual(
		localProps,
	);
	const links = bundleLinks(pathShard, b.caseId);
	for (const ref of Object.keys(localDownloads))
		expect(links.downloads[ref]).toBe(
			`/cases/${b.caseId}/originals/${encodeURIComponent(ref)}?download=1`,
		);
	expect(shardDownloads).toEqual({});
});
