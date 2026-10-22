import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { janitorPlan, openRun, runName, type Kind, type Listed, type Provider, type RunManifest } from '../../../deploy/probes/cloud-run.ts';
import { fakeCloud } from './fixtures/fake-cloud.ts';

const REPO = path.join(import.meta.dirname, '../../..');
const SCRATCH = path.join(REPO, '.local/hosting-probe/deployment', `cloud-run-${process.pid}`);
const CHILD = path.join(import.meta.dirname, 'fixtures/cloud-run-child.ts');
const NAME = 'cc-107-w1-abc1234';
const RUN_ID = '00000000-0000-4000-8000-000000000107';
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

let n = 0;
/** A fresh manifests directory and fake cloud, seeded with an older run's resources and an unprefixed one the run must not touch. */
function world() {
	const root = path.join(SCRATCH, `w${++n}`);
	const cloud = path.join(root, 'cloud');
	for (const r of ['worker/cc-107-w9-1234567', 'd1/cc-107-w9-1234567', 'r2/clearcase-prod']) mkdirSync(path.join(cloud, r), { recursive: true });
	return { manifests: path.join(root, 'cloud-runs'), cloud, provider: fakeCloud(cloud) };
}
const manifest = (dir: string) => JSON.parse(readFileSync(path.join(dir, readdirSync(dir).find((file) => file.endsWith('.json'))!), 'utf8')) as RunManifest;
const OTHERS = ['d1/cc-107-w9-1234567', 'r2/clearcase-prod', 'worker/cc-107-w9-1234567'];

describe('run names', () => {
	test('cc-<ticket>-<worker>-<sha7>-<run UUID>, lowercase', () => {
		expect(runName({ ticket: '107', worker: 'W1', sha: 'ABC1234DEF0', runId: RUN_ID })).toBe(`${NAME}-${RUN_ID}`);
		expect(runName({ ticket: '109', worker: 'w2', sha: 'ab12cd3', runId: RUN_ID })).toBe(`cc-109-w2-ab12cd3-${RUN_ID}`);
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
	test('a failed create cannot delete a Worker owned by another checkout', () => {
		const w = world();
		const run = openRun({ dir: w.manifests, ticket: '107', worker: 'w1', sha: 'abc1234', kinds: ['worker'], provider: w.provider, trap: false });
		mkdirSync(path.join(w.cloud, 'worker', run.name), { recursive: true });
		expect(() => run.create('worker')).toThrow(/exists/);
		run.teardown();
		expect(w.provider.names()).toContain(`worker/${run.name}`);
	});

	test('two checkout manifests have distinct names and each teardown removes only its own Worker', () => {
		const w = world();
		const first = openRun({ dir: w.manifests, ticket: '107', worker: 'w1', sha: 'abc1234', kinds: ['worker'], provider: w.provider, trap: false });
		const secondDir = path.join(path.dirname(w.manifests), 'other-checkout-runs');
		const second = openRun({ dir: secondDir, ticket: '107', worker: 'w1', sha: 'abc1234', kinds: ['worker'], provider: w.provider, trap: false });
		expect(manifest(w.manifests).runId).not.toBe(manifest(secondDir).runId);
		expect(first.name).not.toBe(second.name);
		first.create('worker');
		second.create('worker');
		first.teardown();
		expect(w.provider.names()).toContain(`worker/${second.name}`);
		second.teardown();
		expect(w.provider.names()).toEqual(OTHERS);
	});

	test('two checkouts using an upsert provider keep the second run Worker after the first teardown', () => {
		const w = world();
		const resources = new Map<string, string>();
		const provider = (owner: string): Provider => ({
			create: (kind, name) => { resources.set(`${kind}/${name}`, owner); },
			remove: (kind, name) => { resources.delete(`${kind}/${name}`); },
		});
		const first = openRun({ dir: w.manifests, ticket: '107', worker: 'w1', sha: 'abc1234', kinds: ['worker'], provider: provider('first'), trap: false });
		const second = openRun({ dir: path.join(path.dirname(w.manifests), 'other-checkout-runs'), ticket: '107', worker: 'w1', sha: 'abc1234', kinds: ['worker'], provider: provider('second'), trap: false });
		first.create('worker');
		second.create('worker');
		expect(resources.get(`worker/${second.name}`)).toBe('second');
		first.teardown();
		expect(resources.get(`worker/${second.name}`)).toBe('second');
		second.teardown();
		expect(resources.size).toBe(0);
	});

	test('Worker, D1 and R2 names all carry the checkout run identity', () => {
		const w = world();
		const first = openRun({ dir: w.manifests, ticket: '107', worker: 'w1', sha: 'abc1234', kinds: ['worker', 'd1', 'r2'], provider: w.provider, trap: false });
		const second = openRun({ dir: path.join(path.dirname(w.manifests), 'other-checkout-runs'), ticket: '107', worker: 'w1', sha: 'abc1234', kinds: ['worker', 'd1', 'r2'], provider: w.provider, trap: false });
		for (const kind of ['worker', 'd1', 'r2'] as const) {
			first.create(kind);
			second.create(kind);
		}
		expect(first.name).not.toBe(second.name);
		first.teardown();
		expect(w.provider.names()).toEqual(['worker', 'd1', 'r2'].map((kind) => `${kind}/${second.name}`).concat(OTHERS).sort());
		second.teardown();
		expect(w.provider.names()).toEqual(OTHERS);
	});

	test('the manifest lists every resource before the first is created', () => {
		const w = world();
		mkdirSync(path.join(w.cloud, 'r2', NAME), { recursive: true });
		const seen: string[] = [];
		const run = openRun({ ...w, dir: w.manifests, ticket: '107', worker: 'w1', sha: 'abc1234', kinds: ['worker', 'd1', 'r2'], trap: false, provider: {
			create: (kind, name) => (seen.push(`${kind}:${manifest(w.manifests).resources.map((r) => `${r.kind}/${r.name}/${r.created}`).join(',')}`), w.provider.create(kind, name)),
			remove: w.provider.remove,
		} });
		run.create('worker');
		run.create('d1');
		expect(seen[0]).toBe(`worker:worker/${run.name}/false,d1/${run.name}/false,r2/${run.name}/false`);
		expect(seen[1]).toBe(`d1:worker/${run.name}/true,d1/${run.name}/false,r2/${run.name}/false`);
		expect(manifest(w.manifests).state).toBe('open');
		const done = run.teardown();
		expect(done.resources.map((r) => [r.kind, r.created, r.teardown])).toEqual([['worker', true, 'deleted'], ['d1', true, 'deleted'], ['r2', false, 'pending']]);
		expect(w.provider.names()).toEqual([`r2/${NAME}`, ...OTHERS].sort());
	});

	test('a second run in the same manifest directory gets its own name and claim', () => {
		const w = world();
		const first = openRun({ dir: w.manifests, ticket: '107', worker: 'w1', sha: 'abc1234', kinds: ['d1'], provider: w.provider, trap: false });
		const second = openRun({ dir: w.manifests, ticket: '107', worker: 'w1', sha: 'abc1234', kinds: ['d1'], provider: w.provider, trap: false });
		expect(second.name).not.toBe(first.name);
		expect(readdirSync(w.manifests)).toHaveLength(2);
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
		const name = manifest(w.manifests).name;
		mkdirSync(path.join(w.cloud, 'worker', name)); // exists without a successful, recorded create by this run
		const code = await new Promise((resolve) => (child.on('close', (c) => resolve(c)), child.kill('SIGTERM')));
		expect(code).toBe(143);
		expect(manifest(w.manifests).resources.map((x) => `${x.kind}:${x.created}:${x.teardown}`)).toEqual(['worker:false:pending', 'd1:true:deleted', 'r2:true:deleted']);
		expect(w.provider.names()).toEqual([`worker/${name}`, ...OTHERS].sort());
	});

	test('a failed delete is recorded and the rest are still deleted', () => {
		const w = world();
		const r = spawnSync(process.execPath, [CHILD, w.manifests, w.cloud, 'exit', 'r2,d1,worker', 'd1'], { encoding: 'utf8' });
		expect(r.status).toBe(0);
		const m = manifest(w.manifests);
		expect(m.state).toBe('finished');
		expect(m.resources.map((x) => `${x.kind}:${x.teardown}:${x.error}`)).toEqual(['worker:deleted:null', 'd1:failed:synthetic d1 delete failure', 'r2:deleted:null']);
		expect(w.provider.names()).toEqual([`d1/${m.name}`, ...OTHERS]);
	});
});

describe('teardown deletes only what this run opened (M3)', () => {
	/** A provider that records every call, over the fake cloud. */
	const spy = (w: ReturnType<typeof world>) => {
		const removed: string[] = [];
		return { removed, provider: { create: w.provider.create, remove: (kind: Kind, name: string) => (removed.push(`${kind}/${name}`), w.provider.remove(kind, name)) } };
	};
	const open = (w: ReturnType<typeof world>, provider: Provider) => openRun({ dir: w.manifests, ticket: '107', worker: 'w1', sha: 'abc1234', kinds: ['worker', 'd1', 'r2'], provider, trap: false });
	const rewrite = (w: ReturnType<typeof world>, edit: (m: RunManifest) => void) => {
		const m = manifest(w.manifests);
		edit(m);
		writeFileSync(path.join(w.manifests, `${m.name}.json`), JSON.stringify(m));
	};

	test("a manifest rewritten during the run to list an unprefixed D1 deletes nothing but the run's own", () => {
		const w = world();
		mkdirSync(path.join(w.cloud, 'd1', 'clearcase-client-a-db'), { recursive: true });
		mkdirSync(path.join(w.cloud, 'worker', NAME), { recursive: true });
		mkdirSync(path.join(w.cloud, 'r2', NAME), { recursive: true });
		const { removed, provider } = spy(w);
		const run = open(w, provider);
		run.create('d1');
		rewrite(w, (m) => m.resources.push({ kind: 'd1', name: 'clearcase-client-a-db', created: true, teardown: 'pending', error: null }));
		run.teardown();
		expect(removed).toEqual([`d1/${run.name}`]);
		expect(w.provider.names()).toEqual([`d1/clearcase-client-a-db`, `worker/${NAME}`, `r2/${NAME}`, ...OTHERS].sort());
	});

	test("a manifest rewritten to name another run's resources, or another kind, deletes nothing of theirs", () => {
		const w = world();
		mkdirSync(path.join(w.cloud, 'worker', NAME), { recursive: true });
		mkdirSync(path.join(w.cloud, 'r2', NAME), { recursive: true });
		const { removed, provider } = spy(w);
		const run = open(w, provider);
		run.create('d1');
		rewrite(w, (m) => {
			m.resources[0]!.name = 'cc-107-w9-1234567';
			m.resources[1]!.kind = 'kv' as never;
		});
		run.teardown();
		expect(removed).toEqual([`d1/${run.name}`]);
		expect(w.provider.names()).toEqual([`worker/${NAME}`, `r2/${NAME}`, ...OTHERS].sort());
	});

	test('a manifest deleted or unreadable at teardown still tears down the run and leaves a finished record', () => {
		const w = world();
		mkdirSync(path.join(w.cloud, 'worker', NAME), { recursive: true });
		mkdirSync(path.join(w.cloud, 'r2', NAME), { recursive: true });
		const { removed, provider } = spy(w);
		const run = open(w, provider);
		run.create('d1');
		writeFileSync(run.file, '{ not json');
		const done = run.teardown();
		expect(removed).toEqual([`d1/${run.name}`]);
		expect(w.provider.names()).toEqual([`worker/${NAME}`, `r2/${NAME}`, ...OTHERS].sort());
		expect(done.state).toBe('finished');
		expect(manifest(w.manifests).state).toBe('finished');
	});

	test('a manifest rewritten to finished makes create refuse, since its status is the one thing read from the file', () => {
		const w = world();
		const run = open(w, w.provider);
		rewrite(w, (m) => (m.state = 'finished'));
		expect(() => run.create('d1')).toThrow(/not in the open manifest/);
	});
});

describe('the janitor needs its manifests directory named (L6)', () => {
	test("a checkout's own .local/cloud-runs is never the default: another checkout's open runs would look orphaned", () => {
		const cwd = path.join(SCRATCH, 'checkout');
		mkdirSync(path.join(cwd, '.local/cloud-runs'), { recursive: true });
		const file = path.join(SCRATCH, 'listing-default.json');
		writeFileSync(file, JSON.stringify([{ kind: 'd1', name: 'cc-108-w3-ccccccc', createdAt: '2026-10-19T00:00:00.000Z' }]));
		const r = spawnSync(process.execPath, [path.join(REPO, 'deploy/probes/cloud-run.ts'), 'janitor', '--listing', file, '--now', '2026-10-21T12:00:00.000Z'], { cwd, encoding: 'utf8' });
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/janitor needs --manifests DIR/);
		expect(r.stdout).not.toContain('would delete');
	});
});

describe('janitor dry run', () => {
	const NOW = new Date('2026-10-21T12:00:00.000Z');
	const OLD = '2026-10-20T11:00:00.000Z';
	const FINISHED = `cc-107-w1-aaaaaaa-${RUN_ID}`;
	const ORPHAN = `cc-109-w2-bbbbbbb-${RUN_ID}`;
	const OPEN = `cc-108-w3-ccccccc-${RUN_ID}`;
	const YOUNG = `cc-110-w1-ddddddd-${RUN_ID}`;
	const BAD_TIME = `cc-111-w4-eeeeeee-${RUN_ID}`;
	const listing: Listed[] = [
		{ kind: 'worker', name: FINISHED, createdAt: OLD }, // finished manifest
		{ kind: 'd1', name: FINISHED, createdAt: OLD },
		{ kind: 'r2', name: ORPHAN, createdAt: OLD }, // orphaned: no manifest
		{ kind: 'd1', name: OPEN, createdAt: OLD }, // open manifest
		{ kind: 'd1', name: YOUNG, createdAt: '2026-10-21T00:00:00.000Z' }, // younger than 24 hours
		{ kind: 'worker', name: 'clearcase-client-a', createdAt: OLD }, // unprefixed
		{ kind: 'r2', name: 'cc-prod-files', createdAt: OLD }, // cc- but not a run name
		{ kind: 'worker', name: 'CC-107-W1-AAAAAAA', createdAt: OLD }, // uppercase is not a run name
		{ kind: 'd1', name: BAD_TIME, createdAt: 'yesterday' }, // unreadable time
		{ kind: 'kv' as never, name: FINISHED, createdAt: OLD }, // a kind runs never create
	];
	const manifests = () => {
		const dir = path.join(SCRATCH, 'janitor-runs');
		mkdirSync(dir, { recursive: true });
		const m = (name: string, state: string) => writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ schema: 'clearcase.cloud-run/1', name, state }));
		m(FINISHED, 'finished');
		m(OPEN, 'open');
		return dir;
	};

	test('deletes only old run-named resources whose manifest is finished or missing', () => {
		const plan = janitorPlan({ listing, manifests: manifests(), now: NOW });
		expect(plan.remove.map((r) => `${r.kind}/${r.name}`)).toEqual([`worker/${FINISHED}`, `d1/${FINISHED}`, `r2/${ORPHAN}`]);
		expect(plan.keep.map((k) => `${k.resource.kind}/${k.resource.name}: ${k.reason.split(':')[0]}`)).toEqual([
			`d1/${OPEN}: its manifest is "open", not finished`,
			`d1/${YOUNG}: younger than 24 hours`,
			'worker/clearcase-client-a: not a run name (cc-<ticket>-<worker>-<sha7>-<run UUID>)',
			'r2/cc-prod-files: not a run name (cc-<ticket>-<worker>-<sha7>-<run UUID>)',
			'worker/CC-107-W1-AAAAAAA: not a run name (cc-<ticket>-<worker>-<sha7>-<run UUID>)',
			`d1/${BAD_TIME}: createdAt "yesterday" is not a time`,
			`kv/${FINISHED}: kind kv is not one a run creates`,
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
		expect(r.stdout).toContain(`would delete r2 ${ORPHAN}`);
		expect(r.stdout).toContain('keep worker clearcase-client-a: not a run name');
		expect(r.stdout.trim().split('\n').at(-1)).toBe('JANITOR DRY RUN: 3 to delete, 7 kept, nothing deleted');
		expect(readFileSync(file, 'utf8')).toBe(before);
		expect(existsSync(path.join(dir, 'cc-109-w2-bbbbbbb.json'))).toBe(false);
	});
});
