import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { janitorPlan, openRun, runName, type Listed, type RunManifest } from '../../../deploy/probes/cloud-run.ts';
import { fakeCloud } from './fixtures/fake-cloud.ts';

const REPO = path.join(import.meta.dirname, '../../..');
const SCRATCH = path.join(REPO, '.local/hosting-probe/deployment', `cloud-run-${process.pid}`);
const CHILD = path.join(import.meta.dirname, 'fixtures/cloud-run-child.ts');
const NAME = 'cc-107-w1-abc1234';
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

let n = 0;
/** A fresh manifests directory and fake cloud, seeded with an older run's resources and an unprefixed one the run must not touch. */
function world() {
	const root = path.join(SCRATCH, `w${++n}`);
	const cloud = path.join(root, 'cloud');
	for (const r of ['worker/cc-107-w9-1234567', 'd1/cc-107-w9-1234567', 'r2/clearcase-prod']) mkdirSync(path.join(cloud, r), { recursive: true });
	return { manifests: path.join(root, 'cloud-runs'), cloud, provider: fakeCloud(cloud) };
}
const manifest = (dir: string) => JSON.parse(readFileSync(path.join(dir, `${NAME}.json`), 'utf8')) as RunManifest;
const OTHERS = ['d1/cc-107-w9-1234567', 'r2/clearcase-prod', 'worker/cc-107-w9-1234567'];

describe('run names', () => {
	test('cc-<ticket>-<worker>-<sha7>, lowercase', () => {
		expect(runName({ ticket: '107', worker: 'W1', sha: 'ABC1234DEF0' })).toBe(NAME);
		expect(runName({ ticket: '109', worker: 'w2', sha: 'ab12cd3' })).toBe('cc-109-w2-ab12cd3');
	});
	test.each([
		[{ ticket: 'GRS-107', worker: 'w1', sha: 'abc1234' }, 'a ticket that is not digits'],
		[{ ticket: '107', worker: 'w-1', sha: 'abc1234' }, 'a worker with a hyphen'],
		[{ ticket: '107', worker: 'w1', sha: 'abc12' }, 'a short sha'],
		[{ ticket: '107', worker: 'w1', sha: 'xyz1234' }, 'a sha that is not hex'],
		[{ ticket: '', worker: 'w1', sha: 'abc1234' }, 'no ticket'],
	])('refuses %j (%s)', (input) => expect(() => runName(input)).toThrow(/is not cc-/));
});

describe('run manifest and teardown', () => {
	test('the manifest lists every resource before the first is created', () => {
		const w = world();
		const seen: string[] = [];
		const run = openRun({ ...w, dir: w.manifests, ticket: '107', worker: 'w1', sha: 'abc1234', kinds: ['worker', 'd1', 'r2'], trap: false, provider: {
			create: (kind, name) => (seen.push(`${kind}:${manifest(w.manifests).resources.map((r) => `${r.kind}/${r.name}/${r.created}`).join(',')}`), w.provider.create(kind, name)),
			remove: w.provider.remove,
		} });
		run.create('worker');
		run.create('d1');
		expect(seen[0]).toBe(`worker:worker/${NAME}/false,d1/${NAME}/false,r2/${NAME}/false`);
		expect(seen[1]).toBe(`d1:worker/${NAME}/true,d1/${NAME}/false,r2/${NAME}/false`);
		expect(manifest(w.manifests).state).toBe('open');
		const done = run.teardown();
		expect(done.resources.map((r) => [r.kind, r.created, r.teardown])).toEqual([['worker', true, 'deleted'], ['d1', true, 'deleted'], ['r2', false, 'deleted']]);
		expect(w.provider.names()).toEqual(OTHERS);
	});

	test('a second run with the same name is refused', () => {
		const w = world();
		openRun({ dir: w.manifests, ticket: '107', worker: 'w1', sha: 'abc1234', kinds: ['d1'], provider: w.provider, trap: false });
		expect(() => openRun({ dir: w.manifests, ticket: '107', worker: 'w1', sha: 'abc1234', kinds: ['d1'], provider: w.provider, trap: false })).toThrow(/exists/);
	});

	test.each([
		['exit', 'a normal exit', 0],
		['throw', 'an uncaught error', 1],
	])('the exit trap deletes exactly the manifest\'s resources after %s (%s)', (end, _why, code) => {
		const w = world();
		const r = spawnSync(process.execPath, [CHILD, w.manifests, w.cloud, end, 'r2,d1,worker'], { encoding: 'utf8' });
		expect(r.stdout).toContain('created r2,d1,worker');
		expect(r.status).toBe(code);
		const m = manifest(w.manifests);
		expect(m.state).toBe('finished');
		expect(m.resources.map((x) => `${x.kind}:${x.created}:${x.teardown}`)).toEqual(['worker:true:deleted', 'd1:true:deleted', 'r2:true:deleted']);
		expect(w.provider.names()).toEqual(OTHERS);
	});

	test('SIGTERM mid-run tears down what was created, and a resource never created is still deleted if present', async () => {
		const w = world();
		const child = spawn(process.execPath, [CHILD, w.manifests, w.cloud, 'wait', 'r2,d1'], { stdio: ['ignore', 'pipe', 'inherit'] });
		await new Promise<void>((resolve) => child.stdout.on('data', (d: Buffer) => d.toString().includes('created') && resolve()));
		mkdirSync(path.join(w.cloud, 'worker', NAME)); // created by the provider, but the run died before recording it
		const code = await new Promise((resolve) => (child.on('close', (c) => resolve(c)), child.kill('SIGTERM')));
		expect(code).toBe(143);
		expect(manifest(w.manifests).resources.map((x) => `${x.kind}:${x.created}:${x.teardown}`)).toEqual(['worker:false:deleted', 'd1:true:deleted', 'r2:true:deleted']);
		expect(w.provider.names()).toEqual(OTHERS);
	});

	test('a failed delete is recorded and the rest are still deleted', () => {
		const w = world();
		const r = spawnSync(process.execPath, [CHILD, w.manifests, w.cloud, 'exit', 'r2,d1,worker', 'd1'], { encoding: 'utf8' });
		expect(r.status).toBe(0);
		const m = manifest(w.manifests);
		expect(m.state).toBe('finished');
		expect(m.resources.map((x) => `${x.kind}:${x.teardown}:${x.error}`)).toEqual(['worker:deleted:null', 'd1:failed:synthetic d1 delete failure', 'r2:deleted:null']);
		expect(w.provider.names()).toEqual([`d1/${NAME}`, ...OTHERS]);
	});
});

describe('janitor dry run', () => {
	const NOW = new Date('2026-10-21T12:00:00.000Z');
	const OLD = '2026-10-20T11:00:00.000Z';
	const listing: Listed[] = [
		{ kind: 'worker', name: 'cc-107-w1-aaaaaaa', createdAt: OLD }, // finished manifest
		{ kind: 'd1', name: 'cc-107-w1-aaaaaaa', createdAt: OLD },
		{ kind: 'r2', name: 'cc-109-w2-bbbbbbb', createdAt: OLD }, // orphaned: no manifest
		{ kind: 'd1', name: 'cc-108-w3-ccccccc', createdAt: OLD }, // open manifest
		{ kind: 'd1', name: 'cc-110-w1-ddddddd', createdAt: '2026-10-21T00:00:00.000Z' }, // younger than 24 hours
		{ kind: 'worker', name: 'clearcase-client-a', createdAt: OLD }, // unprefixed
		{ kind: 'r2', name: 'cc-prod-files', createdAt: OLD }, // cc- but not a run name
		{ kind: 'worker', name: 'CC-107-W1-AAAAAAA', createdAt: OLD }, // uppercase is not a run name
		{ kind: 'd1', name: 'cc-111-w4-eeeeeee', createdAt: 'yesterday' }, // unreadable time
		{ kind: 'kv' as never, name: 'cc-107-w1-aaaaaaa', createdAt: OLD }, // a kind runs never create
	];
	const manifests = () => {
		const dir = path.join(SCRATCH, 'janitor-runs');
		mkdirSync(dir, { recursive: true });
		const m = (name: string, state: string) => writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ schema: 'clearcase.cloud-run/1', name, state }));
		m('cc-107-w1-aaaaaaa', 'finished');
		m('cc-108-w3-ccccccc', 'open');
		return dir;
	};

	test('deletes only old run-named resources whose manifest is finished or missing', () => {
		const plan = janitorPlan({ listing, manifests: manifests(), now: NOW });
		expect(plan.remove.map((r) => `${r.kind}/${r.name}`)).toEqual(['worker/cc-107-w1-aaaaaaa', 'd1/cc-107-w1-aaaaaaa', 'r2/cc-109-w2-bbbbbbb']);
		expect(plan.keep.map((k) => `${k.resource.kind}/${k.resource.name}: ${k.reason.split(':')[0]}`)).toEqual([
			'd1/cc-108-w3-ccccccc: its manifest is "open", not finished',
			'd1/cc-110-w1-ddddddd: younger than 24 hours',
			'worker/clearcase-client-a: not a run name (cc-<ticket>-<worker>-<sha7>)',
			'r2/cc-prod-files: not a run name (cc-<ticket>-<worker>-<sha7>)',
			'worker/CC-107-W1-AAAAAAA: not a run name (cc-<ticket>-<worker>-<sha7>)',
			'd1/cc-111-w4-eeeeeee: createdAt "yesterday" is not a time',
			'kv/cc-107-w1-aaaaaaa: kind kv is not one a run creates',
		]);
	});

	test('a missing manifests directory is refused, not read as every run orphaned', () => {
		const absent = path.join(SCRATCH, 'no-such-runs');
		expect(() => janitorPlan({ listing, manifests: absent, now: NOW })).toThrow(/no-such-runs is not a directory/);
		const file = path.join(SCRATCH, 'listing-absent.json');
		writeFileSync(file, JSON.stringify(listing));
		for (const args of [['--manifests', absent], ['--manifests']]) {
			const r = spawnSync(process.execPath, [path.join(REPO, 'deploy/probes/cloud-run.ts'), 'janitor', '--listing', file, ...args, '--now', NOW.toISOString()], { cwd: SCRATCH, encoding: 'utf8' });
			expect(r.status).toBe(1);
			expect(r.stdout).not.toContain('would delete');
		}
	});

	test('the CLI dry run prints the plan and changes no file', () => {
		const dir = manifests();
		const file = path.join(SCRATCH, 'listing.json');
		writeFileSync(file, JSON.stringify(listing));
		const before = readFileSync(file, 'utf8');
		const r = spawnSync(process.execPath, [path.join(REPO, 'deploy/probes/cloud-run.ts'), 'janitor', '--listing', file, '--manifests', dir, '--now', NOW.toISOString()], { encoding: 'utf8' });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('would delete r2 cc-109-w2-bbbbbbb');
		expect(r.stdout).toContain('keep worker clearcase-client-a: not a run name');
		expect(r.stdout.trim().split('\n').at(-1)).toBe('JANITOR DRY RUN: 3 to delete, 7 kept, nothing deleted');
		expect(readFileSync(file, 'utf8')).toBe(before);
		expect(existsSync(path.join(dir, 'cc-109-w2-bbbbbbb.json'))).toBe(false);
	});
});
