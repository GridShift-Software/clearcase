// Disposable cloud resources for proof runs (GRS-107, the 17 October local-first plan on GRS-26). Every Worker, D1
// database and R2 bucket a run creates is named cc-<ticket>-<worker>-<sha7>, in lowercase. A run claims its manifest,
// <dir>/<name>.json, with a unique run id before it creates anything, records each successful provider creation, and
// an exit trap deletes only the (kind, name) pairs whose creation was recorded, held in memory and checked against the run's name
// (the Worker first, then the database, then the bucket), and records each result. The manifest file is a record
// for operators and the janitor: the run reads only its status, so a file rewritten during the run deletes nothing.
// The janitor deletes only cc-* resources older than 24 hours whose manifest is finished or missing, and never one
// whose name is not a run name. Creating and deleting go through a Provider; the Cloudflare provider and the janitor's real
// sweep are cloud legs held for M1.
//
//   bun deploy/probes/cloud-run.ts name --ticket 107 --worker w1 [--sha <commit>]
//   bun deploy/probes/cloud-run.ts janitor --listing FILE --manifests DIR [--now ISO]
//
// `janitor` is a dry run: it prints the plan for a resource listing (a JSON array of { kind, name, createdAt }) and
// deletes nothing. It has no default manifests directory: a default inside one checkout would read another checkout's
// open runs as orphaned.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUN_SCHEMA = 'clearcase.cloud-run/1';
export const RUN_NAME = /^cc-([0-9]{1,6})-([a-z0-9]{1,12})-([0-9a-f]{7})$/;
export const MAX_AGE_HOURS = 24;
/** Teardown order: the Worker first, so nothing writes to its database or bucket while they are deleted; the bucket last. */
export const KINDS = ['worker', 'd1', 'r2'] as const;
export type Kind = (typeof KINDS)[number];

export type Resource = { kind: Kind; name: string; created: boolean; teardown: 'pending' | 'deleted' | 'failed'; error: string | null };
export type RunManifest = { schema: typeof RUN_SCHEMA; runId: string; name: string; sha: string; createdAt: string; state: 'open' | 'finished'; finishedAt: string | null; resources: Resource[] };
export type Listed = { kind: Kind; name: string; createdAt: string };

/** What a run asks of the cloud. `remove` empties a bucket before deleting it, and succeeds when the resource is already gone. */
export interface Provider {
	create(kind: Kind, name: string): void;
	remove(kind: Kind, name: string): void;
}

export function runName(a: { ticket: string; worker: string; sha: string }): string {
	const name = `cc-${a.ticket}-${a.worker}-${a.sha.slice(0, 7)}`.toLowerCase();
	if (!RUN_NAME.test(name) || !/^[0-9a-f]{7,40}$/i.test(a.sha)) throw new Error(`${name} is not cc-<ticket digits>-<worker [a-z0-9]>-<sha7>`);
	return name;
}

const write = (file: string, m: RunManifest, claim = false) => {
	const body = `${JSON.stringify(m, null, 2)}\n`;
	if (claim) {
		writeFileSync(file, body, { flag: 'wx' });
		return;
	}
	const temporary = `${file}.${m.runId}.tmp`;
	writeFileSync(temporary, body);
	renameSync(temporary, file);
};

export type Run = { name: string; file: string; create(kind: Kind): void; teardown(): RunManifest };

/**
 * Writes the manifest for one run before anything exists, then hands back create and teardown. An exit trap (normal
 * exit, an uncaught error, SIGINT, SIGTERM or SIGHUP) runs the teardown once; SIGKILL leaves the manifest open for an
 * operator, and the janitor never deletes an open run's resources.
 */
export function openRun(a: { dir: string; ticket: string; worker: string; sha: string; kinds: Kind[]; provider: Provider; now?: () => Date; trap?: boolean }): Run {
	const now = a.now ?? (() => new Date());
	const name = runName(a);
	const file = path.join(a.dir, `${name}.json`);
	if (new Set(a.kinds).size !== a.kinds.length || !a.kinds.length) throw new Error(`kinds ${a.kinds.join(',')} must be distinct and nonempty`);
	mkdirSync(a.dir, { recursive: true });
	const order = [...a.kinds].sort((x, y) => KINDS.indexOf(x) - KINDS.indexOf(y));
	const manifest: RunManifest = { schema: RUN_SCHEMA, runId: randomUUID(), name, sha: a.sha, createdAt: now().toISOString(), state: 'open', finishedAt: null, resources: order.map((kind) => ({ kind, name, created: false, teardown: 'pending', error: null })) };
	try {
		write(file, manifest, true);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${file} exists: one manifest per run name`);
		throw e;
	}
	// A successful provider create and a durable manifest update both precede ownership.
	const owned = new Set<Kind>();
	/** The one thing read back from the file: whether the run is still open. */
	const status = () => {
		try {
			const record = JSON.parse(readFileSync(file, 'utf8')) as RunManifest;
			return record.runId === manifest.runId ? record.state : 'unreadable';
		} catch {
			return 'unreadable';
		}
	};
	let done: RunManifest | null = null;
	const run: Run = {
		name,
		file,
		create(kind) {
			const r = manifest.resources.find((x) => x.kind === kind);
			if (!r || manifest.state !== 'open' || status() !== 'open') throw new Error(`${name}: ${kind} is not in the open manifest`);
			a.provider.create(kind, name);
			r.created = true;
			write(file, manifest);
			owned.add(kind);
		},
		teardown() {
			if (done) return done;
			for (const r of manifest.resources) {
				if (!owned.has(r.kind)) continue;
				try {
					// A successful provider create and manifest record are required, whatever the file or caller says.
					if (r.name !== name || !RUN_NAME.test(r.name) || !KINDS.includes(r.kind)) throw new Error(`${r.kind} ${r.name} is not one of ${name}'s own`);
					a.provider.remove(r.kind, r.name);
					r.teardown = 'deleted';
				} catch (e) {
					r.teardown = 'failed';
					r.error = e instanceof Error ? e.message : String(e);
				}
			}
			manifest.state = 'finished';
			manifest.finishedAt = now().toISOString();
			write(file, manifest);
			return (done = manifest);
		},
	};
	if (a.trap !== false) {
		process.once('exit', () => void run.teardown());
		for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) process.once(signal, () => (run.teardown(), process.exit(code)));
		process.once('uncaughtException', (e) => (console.error(e), run.teardown(), process.exit(1)));
	}
	return run;
}

export type Plan = { remove: Listed[]; keep: { resource: Listed; reason: string }[] };

/** Which listed resources the janitor deletes: run names only, older than MAX_AGE_HOURS, whose manifest is finished or missing. */
export function janitorPlan(a: { listing: Listed[]; manifests: string; now: Date }): Plan {
	if (!existsSync(a.manifests) || !statSync(a.manifests).isDirectory()) throw new Error(`${a.manifests} is not a directory: without the run manifests every old run would look orphaned`);
	const plan: Plan = { remove: [], keep: [] };
	for (const resource of a.listing) {
		const keep = (reason: string) => plan.keep.push({ resource, reason });
		const created = Date.parse(resource.createdAt);
		const file = path.join(a.manifests, `${resource.name}.json`);
		if (!KINDS.includes(resource.kind)) keep(`kind ${resource.kind} is not one a run creates`);
		else if (!RUN_NAME.test(resource.name)) keep('not a run name (cc-<ticket>-<worker>-<sha7>): never touched');
		else if (!Number.isFinite(created)) keep(`createdAt ${JSON.stringify(resource.createdAt)} is not a time`);
		else if (a.now.getTime() - created < MAX_AGE_HOURS * 3_600_000) keep(`younger than ${MAX_AGE_HOURS} hours`);
		else if (!existsSync(file)) plan.remove.push(resource);
		else {
			let state: unknown;
			try {
				state = (JSON.parse(readFileSync(file, 'utf8')) as RunManifest).state;
			} catch {
				state = 'unreadable';
			}
			if (state === 'finished') plan.remove.push(resource);
			else keep(`its manifest is ${JSON.stringify(state)}, not finished: an open run, or one an operator must read`);
		}
	}
	return plan;
}

function parseListing(value: unknown): Listed[] {
	if (!Array.isArray(value)) throw new Error('the listing is not a JSON array');
	return value.map((r, i) => {
		if (typeof r !== 'object' || r === null || typeof r.kind !== 'string' || typeof r.name !== 'string' || typeof r.createdAt !== 'string') throw new Error(`listing[${i}] is not { kind, name, createdAt }`);
		return { kind: r.kind, name: r.name, createdAt: r.createdAt };
	});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [command, ...rest] = process.argv.slice(2);
	const arg = (name: string) => {
		const i = rest.indexOf(name);
		if (i >= 0 && (rest[i + 1] === undefined || rest[i + 1]!.startsWith('--'))) throw new Error(`${name} needs a value`);
		return i < 0 ? undefined : rest[i + 1];
	};
	try {
		if (command === 'name') {
			const sha = arg('--sha') ?? (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
			console.log(runName({ ticket: arg('--ticket') ?? '', worker: arg('--worker') ?? '', sha }));
		} else if (command === 'janitor') {
			const listing = arg('--listing');
			if (!listing) throw new Error('janitor needs --listing FILE');
			const manifests = arg('--manifests');
			if (!manifests) throw new Error('janitor needs --manifests DIR: it has no default, because a default inside one checkout would read another checkout\'s open runs as orphaned');
			const now = new Date(arg('--now') ?? Date.now());
			if (!Number.isFinite(now.getTime())) throw new Error('--now is not a time');
			const plan = janitorPlan({ listing: parseListing(JSON.parse(readFileSync(listing, 'utf8'))), manifests: path.resolve(manifests), now });
			for (const r of plan.remove) console.log(`would delete ${r.kind} ${r.name} (created ${r.createdAt})`);
			for (const k of plan.keep) console.log(`keep ${k.resource.kind} ${k.resource.name}: ${k.reason}`);
			console.log(`JANITOR DRY RUN: ${plan.remove.length} to delete, ${plan.keep.length} kept, nothing deleted`);
		} else {
			console.error('usage: cloud-run.ts name --ticket N --worker W [--sha SHA] | janitor --listing FILE --manifests DIR [--now ISO]');
			process.exit(2);
		}
	} catch (e) {
		console.error(`cloud-run: ${(e as Error).message}`);
		process.exit(1);
	}
}
