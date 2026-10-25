// Strict native-stage -> observed-ControlManifest binder (NATIVE24). RED first, then the module. The stages here are REAL:
// built by the real `stageNative` on a real temp directory from synthetic fixtures and judged by the real
// `checkNativeStage` (no mock of the checker, the filesystem or the hashing). The ControlManifest, the provider
// readback and the clock are injected data. A PASS here is structural, local and synthetic: never provider proof, a
// controls proof, a funded admission, a real EU placement or a deploy.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { NATIVE_CONTROLS_SCHEMA, bindStageRecord, parseNativeManifest, type NativeManifest, type ProviderReadback } from '../../../../deploy/native-alpha/controls.ts';
import { bindNativeStages, nativeBindingProblems, sha256Text, type BindInput, type NativeStageEvidence, type NativeStageReader } from '../../../../deploy/native-alpha/native-stage-binding.ts';
import { nativeStageRecord, parseNativeJson, parseNativeTarget, type NativePins } from '../../../../deploy/native-alpha/pipeline.ts';
import { checkNativeStage, digestDir, readRegular, stageNative } from '../../../../deploy/probes/target.ts';

const ROOT = path.join(import.meta.dirname, '../../../..');
const MODULE = path.join(ROOT, 'deploy/native-alpha/native-stage-binding.ts');
const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const SCRATCH = path.join(ROOT, '.local/hosting-probe/deployment', `native-binder-${process.pid}`);
mkdirSync(SCRATCH, { recursive: true });
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const ACCOUNT = 'fb4c31b91c5d89b7a54afbdc34823170';
const ZONE = 'db7c322907320aba562d64015ee7d673';
const PROFILE = 'c'.repeat(40);
const NOW = 2_000_000;
const OBSERVED_AT = NOW - 1_000;
const READ_AT = NOW - 500;
const CLIENTS = ['client-a', 'client-b'] as const;
const OTHER_UUID = '11111111-1111-4111-8111-111111111111';

let n = 0;
const scratch = (name: string) => path.join(SCRATCH, `${name}-${++n}`);
const sha = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const hex = (c: string, len = 32) => c.repeat(len);
const uuid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const refusedWith = (problems: string[], reason: RegExp | string) => expect(problems.some((p) => (typeof reason === 'string' ? p.includes(reason) : reason.test(p))), problems.join('\n') || '(no problems)').toBe(true);
const copy = (src: string, edit: (dir: string) => void = () => {}) => {
	const dir = scratch('copy');
	cpSync(src, dir, { recursive: true });
	edit(dir);
	return dir;
};
const editJson = (file: string, edit: (v: Record<string, any>) => void) => {
	const v = JSON.parse(readFileSync(file, 'utf8'));
	edit(v);
	writeFileSync(file, JSON.stringify(v, null, 2));
};

type World = { clients: string; artifact: string; stages: Record<string, string>; pins: Record<string, NativePins>; manifest: NativeManifest };

const pinsFor = (clients: string, artifact: string, client: string): NativePins => ({
	target: sha(readFileSync(path.join(clients, client, 'target.json'))),
	config: sha(readFileSync(path.join(clients, client, 'wrangler.jsonc'))),
	artifact: digestDir(artifact),
	migrations: digestDir(path.join(clients, client, 'migrations')),
	entry: sha(readFileSync(path.join(artifact, 'cloudflare/_worker.js'))),
	source: JSON.parse(readFileSync(path.join(clients, client, 'target.json'), 'utf8')).runtime.sourceSha,
});

/** The observed ControlManifest a deploy of exactly this reviewed source would leave: ids that only exist after a deploy are synthetic observations. */
function manifestFor(clients: string, artifact: string): NativeManifest {
	const version = sha(readFileSync(path.join(artifact, 'public/_app/version.json')));
	const entry = (letter: 'a' | 'b', c: string, d: string) => {
		const t = JSON.parse(readFileSync(path.join(clients, `client-${letter}`, 'target.json'), 'utf8'));
		return {
			client: t.client,
			worker: t.worker,
			domain: { id: hex(c), hostname: t.customDomain.hostname, zoneId: t.customDomain.zoneId, service: t.worker, environment: 'production' },
			versionIds: [uuid(c), uuid(d)],
			secretNames: [...t.secrets],
			d1: { ...t.d1 },
			r2: { binding: t.r2.binding, bucket: t.r2.bucket, jurisdiction: t.r2.jurisdiction },
			release: { sourceSha: t.runtime.sourceSha, artifactSha256: t.runtime.artifactSha256, profileRevision: PROFILE },
			canary: { appPath: '/', assetPath: '/_app/version.json', assetSha256: version },
		};
	};
	return { schema: NATIVE_CONTROLS_SCHEMA, accountId: ACCOUNT, zone: { id: ZONE, name: 'gridshift.co.za' }, clients: [entry('a', '1', '2'), entry('b', '3', '4')] } as NativeManifest;
}

function readbackFor(m: NativeManifest): ProviderReadback {
	return {
		accountId: m.accountId,
		zoneId: m.zone.id,
		observedAt: OBSERVED_AT,
		domains: m.clients.map((c) => ({ ...c.domain })),
		routes: [],
		routesComplete: true,
		accountZones: { complete: true, items: [{ id: m.zone.id, name: m.zone.name }] },
		otherZoneRoutes: [],
		workers: m.clients.map((c) => ({ worker: c.worker, workersDev: false, previews: false, versionIds: [...c.versionIds], secretNames: [...c.secretNames] })),
		d1: m.clients.map((c) => ({ id: c.d1.id, name: c.d1.name, jurisdiction: 'eu' })),
		r2: m.clients.map((c) => ({ bucket: c.r2.bucket, jurisdiction: 'eu', managedDomainEnabled: false, customDomains: [] })),
	};
}

/** A real world: both clients staged by the real stageNative, six real pins each, and the observed manifest of that release. */
function world(clients = path.join(FIXTURES, 'clients'), artifact = path.join(FIXTURES, 'artifact')): World {
	const stages: Record<string, string> = {};
	const pins: Record<string, NativePins> = {};
	for (const client of CLIENTS) {
		const out = scratch(`stage-${client}`);
		expect(stageNative({ client, artifact, digest: digestDir(artifact), out, clients })).toEqual([]);
		stages[client] = out;
		pins[client] = pinsFor(clients, artifact, client);
	}
	return { clients, artifact, stages, pins, manifest: manifestFor(clients, artifact) };
}

/** The typed parent adapter: the REAL checkNativeStage before and after reading the stage's bytes with the real readRegular. */
function realReader(w: World, readAt = READ_AT, tamper?: (client: string, e: NativeStageEvidence) => void): NativeStageReader {
	return {
		read(client) {
			const stage = w.stages[client]!;
			const check = () => checkNativeStage({ client, stage, clients: w.clients, pins: w.pins[client]! });
			const first = check();
			const file = (f: string) => readRegular(path.join(stage, f), stage).toString('utf8');
			const files = { stageJson: file('stage.json'), targetJson: file('target.json'), configJsonc: file('wrangler.jsonc') };
			const second = check();
			const e: NativeStageEvidence = { schema: 'clearcase.native-stage-evidence/1', checker: 'checkNativeStage', client, pins: w.pins[client]!, problems: [...first, ...second.filter((p) => !first.includes(p))], readAt, files };
			tamper?.(client, e);
			return e;
		},
	};
}

const input = (w: World, over: Partial<BindInput> = {}): BindInput => ({
	observed: { manifest: w.manifest, readback: readbackFor(w.manifest) },
	pins: w.pins,
	profileRevision: PROFILE,
	reader: realReader(w),
	now: () => NOW,
	...over,
});
const bind = (w: World, over: Partial<BindInput> = {}) => bindNativeStages(input(w, over));
const hold = (r: ReturnType<typeof bindNativeStages>, reason: RegExp | string) => {
	expect(r.state).toBe('HOLD');
	expect(r.bound).toEqual([]);
	refusedWith(r.problems, reason);
};

/**
 * An attacker who controls the evidence reader: the staged files are edited and the whole stage record and the pins that
 * would cover them are recomputed to agree, and the reader reports no problems. Only the binder's own independent checks
 * (and the observed manifest) can refuse this.
 */
function forge(w: World, client: string, o: { target?: (t: Record<string, any>) => void; config?: (text: string) => string; pins?: Partial<NativePins>; record?: (r: Record<string, any>) => void; stageText?: (s: string) => string } = {}) {
	const real = realReader(w).read(client);
	const targetV = JSON.parse(real.files.targetJson);
	o.target?.(targetV);
	const targetJson = JSON.stringify(targetV, null, 2);
	const configJsonc = o.config ? o.config(real.files.configJsonc) : real.files.configJsonc;
	const old = JSON.parse(real.files.stageJson);
	const record = nativeStageRecord(parseNativeTarget(parseNativeJson(targetJson), 'forged'), { files: { 'target.json': sha(targetJson), 'wrangler.jsonc': sha(configJsonc) }, artifact: old.artifact, migrations: old.migrations, upload: old.upload }) as Record<string, any>;
	const mutable = clone(record);
	o.record?.(mutable);
	const stageJson = o.stageText ? o.stageText(`${JSON.stringify(mutable, null, 2)}\n`) : `${JSON.stringify(mutable, null, 2)}\n`;
	const pins: NativePins = { ...real.pins, target: sha(targetJson), config: sha(configJsonc), ...o.pins };
	const evidence: NativeStageEvidence = { ...real, pins, problems: [], files: { stageJson, targetJson, configJsonc } };
	return { evidence, pins };
}
const lying = (w: World, client: string, f: ReturnType<typeof forge>) => ({
	reader: realReader(w, READ_AT, (c, e) => c === client && Object.assign(e, f.evidence)),
	pins: { ...w.pins, [client]: f.pins },
});

describe('reviewer regressions M1–M4', () => {
	const w = world();

	test('M1: a reader cannot replace the reviewed profile revision after validation', () => {
		const a = input(w, { profileRevision: 'd'.repeat(40) });
		a.reader = realReader(w, READ_AT, () => void (a.profileRevision = PROFILE));
		hold(bindNativeStages(a), /profile revision/);
	});

	test('M2: honest completion timestamps use a clock sampled after every read', () => {
		let clock = NOW;
		const reader: NativeStageReader = { read(client) { return realReader(w, ++clock).read(client); } };
		const r = bind(w, { reader, now: () => clock });
		expect(r.problems).toEqual([]);
		expect(r.state).toBe('BOUND-STRUCTURAL');
	});

	test('M3: copied provider observation must still be fresh after the last read', () => {
		let clock = NOW;
		let reads = 0;
		const observed = { manifest: w.manifest, readback: readbackFor(w.manifest) };
		const reader: NativeStageReader = { read(client) {
			const e = realReader(w).read(client);
			if (++reads === 4) { clock += 120_000; observed.readback.observedAt = clock; }
			return e;
		} };
		hold(bind(w, { observed, reader, now: () => clock }), /readback.*stale|readback.*old/i);
	});

	test('M4: expanded real native upload evidence binds without dropping assets or dynamic imports', () => {
		const e = realReader(w).read('client-a');
		const upload = JSON.parse(e.files.stageJson).upload;
		expect(upload.assets.directory).toBe('artifact/public');
		expect(upload.assets.files.some((f: any) => f.path === 'artifact/public/_app/version.json')).toBe(true);
		expect(upload.dynamicHostImports).toEqual([]);
		expect(bind(w).problems).toEqual([]);
	});
});

describe('the honest bound set (control)', () => {
	const w = world();
	const r = bind(w);

	test('two real stages bind to the observed manifest structurally, and only structurally', () => {
		expect(r.problems).toEqual([]);
		expect(r.state).toBe('BOUND-STRUCTURAL');
		expect(r.bound).toHaveLength(2);
		expect(r.structuralOnly).toBe(true);
		expect(r.providerProof).toBe(false);
		expect(r.controlReady).toBe(false);
		expect(r.funded).toBe(false);
		expect(nativeBindingProblems(r)).toEqual([]);
	});

	test('it grants nothing: an exact key set with no permission, grant, approval or upload-allowance field', () => {
		expect(Object.keys(r).sort()).toEqual(['bound', 'controlReady', 'funded', 'legacyConversion', 'problems', 'providerProof', 'schema', 'state', 'structuralOnly']);
		expect(r.legacyConversion).toBe(false);
		expect(JSON.stringify(r)).not.toMatch(/grant|permission|allow|approv/i);
	});

	test('what binds is exactly what was observed and what was read: the bound facts come from the manifest and the evidence', () => {
		const a = r.bound.find((b: any) => b.client === 'client-a') as any;
		const m = w.manifest.clients[0]!;
		expect(a).toMatchObject({ client: 'client-a', accountId: ACCOUNT, zoneId: ZONE, worker: m.worker, hostname: m.domain.hostname, domainId: m.domain.id, d1Id: m.d1.id, r2Bucket: m.r2.bucket, sourceSha: m.release.sourceSha, artifactSha256: m.release.artifactSha256, profileRevision: PROFILE });
		expect(a.versionIds).toEqual(m.versionIds);
		expect(a.secretNames).toEqual(m.secretNames);
		expect(a.targetSha256).toBe(w.pins['client-a']!.target);
		expect(a.configSha256).toBe(w.pins['client-a']!.config);
		expect(a.entrySha256).toBe(w.pins['client-a']!.entry);
		expect(a.stageSha256).toBe(sha(readFileSync(path.join(w.stages['client-a']!, 'stage.json'))));
	});

	test('the result is frozen and holds copies: a reader that keeps and edits its evidence afterwards changes nothing', () => {
		const kept: NativeStageEvidence[] = [];
		const reader = realReader(w, READ_AT, (_c, e) => void kept.push(e));
		const res = bind(w, { reader });
		const before = JSON.stringify(res);
		for (const e of kept) {
			e.files.targetJson = '{}';
			e.problems.push('late');
			e.client = 'client-b';
		}
		expect(JSON.stringify(res)).toBe(before);
		expect(() => ((res as any).state = 'x')).toThrow();
		expect(() => ((res.bound[0] as any).client = 'client-b')).toThrow();
		expect(Object.isFrozen(res.problems)).toBe(true);
	});

	test('the same inputs bind to the same record on a second run (deterministic)', () => {
		expect(JSON.stringify(bind(w))).toBe(JSON.stringify(r));
	});
});

describe('wrong artifact', () => {
	const w = world();

	test('the manifest was observed running a different artifact than the pinned stage', () => {
		const m = clone(w.manifest);
		m.clients[0]!.release.artifactSha256 = `sha256:${hex('e', 64)}`;
		hold(bind(w, { observed: { manifest: m, readback: readbackFor(m) } }), /artifact/i);
	});

	test('a different but fully valid reviewed stage (other bytes, honestly pinned and staged) does not bind to the original observation', () => {
		const artifact = copy(path.join(FIXTURES, 'artifact'), (d) => writeFileSync(path.join(d, 'cloudflare/_worker.js'), 'export default { fetch() { return new Response("other"); } };'));
		const clients = copy(path.join(FIXTURES, 'clients'), (d) => {
			for (const c of CLIENTS) editJson(path.join(d, c, 'target.json'), (t) => (t.runtime.artifactSha256 = digestDir(artifact)));
		});
		const other = world(clients, artifact);
		const res = bind(other, { observed: { manifest: w.manifest, readback: readbackFor(w.manifest) } });
		hold(res, /artifact/i);
	});

	test('a pinned artifact that is not the stage record artifact or the target artifact is refused even if the reader reports no problems', () => {
		const f = forge(w, 'client-a', { pins: { artifact: `sha256:${hex('d', 64)}` } });
		const l = lying(w, 'client-a', f);
		hold(bind(w, l), /artifact/i);
	});

	test('the final Worker entry pin must equal the entry hash recorded for the upload', () => {
		const f = forge(w, 'client-a', { pins: { entry: `sha256:${hex('d', 64)}` } });
		hold(bind(w, lying(w, 'client-a', f)), /entry/i);
	});
});

describe('foreign client and shared identifiers', () => {
	const w = world();

	test("client-b's evidence presented as client-a's is refused", () => {
		const reader: NativeStageReader = { read: (c) => ({ ...realReader(w).read('client-b'), client: c }) };
		hold(bind(w, { reader }), /client-b|client-a/);
	});

	test("client-a's config naming client-b's Worker, hostname, D1 or R2 is refused even if the reader reports no problems", () => {
		for (const [from, to] of [['cc-sbx-a-20261023"', 'cc-sbx-b-20261023"'], ['a.sandbox.gridshift.co.za', 'b.sandbox.gridshift.co.za'], ['cc-sbx-a-20261023-files', 'cc-sbx-b-20261023-files']] as const) {
			const f = forge(w, 'client-a', { config: (t) => t.replace(from, to) });
			hold(bind(w, lying(w, 'client-a', f)), /belongs to client-b|wrangler|config|worker|hostname|r2/i);
		}
	});

	test('two targets that share an identifier (client-b given client-a D1 id, honestly rehashed) are refused as a bound set', () => {
		const aId = JSON.parse(readFileSync(path.join(w.clients, 'client-a/target.json'), 'utf8')).d1.id as string;
		const bId = JSON.parse(readFileSync(path.join(w.clients, 'client-b/target.json'), 'utf8')).d1.id as string;
		const f = forge(w, 'client-b', { target: (t) => (t.d1.id = aId), config: (t) => t.replace(bId, aId) });
		hold(bind(w, lying(w, 'client-b', f)), /shares an identifier.*d1 id.*both client-a's and client-b's/i);
	});

	test('a manifest where two clients share a domain, version or D1 identifier is refused before any binding', () => {
		const m = clone(w.manifest);
		m.clients[1]!.d1.id = m.clients[0]!.d1.id;
		hold(bind(w, { observed: { manifest: m, readback: readbackFor(m) } }), /d1 id|manifest/i);
		const v = clone(w.manifest);
		v.clients[1]!.versionIds[0] = v.clients[0]!.versionIds[0]!;
		hold(bind(w, { observed: { manifest: v, readback: readbackFor(v) } }), /version id|manifest/i);
	});

	test('the stage set must be exactly the manifest clients: a missing, extra or unreadable client is a HOLD', () => {
		hold(bind(w, { reader: { read: (c) => (c === 'client-b' ? (() => { throw new Error('no stage for client-b'); })() : realReader(w).read(c)) } }), /client-b/);
		const { 'client-b': _drop, ...onlyA } = w.pins;
		hold(bind(w, { pins: onlyA }), /pin.*client-b|client-b.*pin/i);
		hold(bind(w, { pins: { ...w.pins, 'client-c': w.pins['client-a']! } }), /client-c/);
	});
});

describe('rehashed, forged or tampered stage', () => {
	const w = world();

	test('a rehashed stage (target, config, record and hashes all consistent) fails the real checker against the reviewed source', () => {
		const forgedClients = copy(w.clients, (d) => {
			editJson(path.join(d, 'client-a/target.json'), (t) => (t.d1.id = OTHER_UUID));
			const file = path.join(d, 'client-a/wrangler.jsonc');
			writeFileSync(file, readFileSync(file, 'utf8').replace('00000000-0000-4000-8000-0000000a0107', OTHER_UUID));
		});
		const forgedStage = scratch('forged-stage');
		expect(stageNative({ client: 'client-a', artifact: w.artifact, digest: digestDir(w.artifact), out: forgedStage, clients: forgedClients })).toEqual([]);
		const forged: World = { ...w, stages: { ...w.stages, 'client-a': forgedStage } };
		const res = bind(forged);
		hold(res, /reviewed|pin target|differs/i);
	});

	test('the same rehashed stage with a reader that reports no problems is refused by the binder itself (the pins are external)', () => {
		const f = forge(w, 'client-a', { target: (t) => (t.d1.id = OTHER_UUID), config: (t) => t.replace('00000000-0000-4000-8000-0000000a0107', OTHER_UUID), pins: {} });
		// the attacker also chose the pins that cover the forged bytes; only the reviewer's own pins for the original are external
		hold(bind(w, { reader: lying(w, 'client-a', f).reader }), /pin|d1/i);
		hold(bind(w, lying(w, 'client-a', f)), /d1/i);
	});

	test('a hand-edited stage.json (a claim flag set true) is not the record of these bytes', () => {
		for (const key of ['providerProof', 'controlsProof', 'fundedAdmission', 'deployed'] as const) {
			const f = forge(w, 'client-a', { record: (r) => (r[key] = true) });
			hold(bind(w, lying(w, 'client-a', f)), /record|stage\.json/i);
		}
		const f = forge(w, 'client-a', { record: (r) => (r.state = 'DEPLOYED') });
		hold(bind(w, lying(w, 'client-a', f)), /record|stage\.json/i);
	});

	test('a stage.json with a non-canonical byte layout is not the record (trailing bytes, key order)', () => {
		const f = forge(w, 'client-a', { stageText: (s) => `${s}\n` });
		hold(bind(w, lying(w, 'client-a', f)), /record|stage\.json/i);
	});

	test('a real stage tampered on disk after staging is reported by the real checker and bound as a HOLD', () => {
		const dir = copy(w.stages['client-a']!);
		writeFileSync(path.join(dir, 'artifact/cloudflare/_worker.js'), 'export default { fetch() { return new Response("swapped"); } };');
		hold(bind({ ...w, stages: { ...w.stages, 'client-a': dir } }), /artifact|entry|pin|record/i);
	});
});

describe('no external pins', () => {
	const w = world();

	test('no pins at all, an empty set, or a client without pins is a HOLD', () => {
		hold(bind(w, { pins: undefined as unknown as BindInput['pins'] }), /pin/i);
		hold(bind(w, { pins: {} }), /pin/i);
		hold(bind(w, { pins: { 'client-a': w.pins['client-a']! } }), /pin/i);
	});

	test('malformed, partial or extra pins are a HOLD', () => {
		hold(bind(w, { pins: { ...w.pins, 'client-a': { ...w.pins['client-a']!, source: 'main' } } }), /pin/i);
		const { entry: _e, ...partial } = w.pins['client-a']!;
		hold(bind(w, { pins: { ...w.pins, 'client-a': partial as unknown as NativePins } }), /pin/i);
		hold(bind(w, { pins: { ...w.pins, 'client-a': { ...w.pins['client-a']!, extra: sha('x') } as unknown as NativePins } }), /pin/i);
	});

	test('pins read from the stage (the evidence names its own pins) are not external: evidence pins that differ from the supplied pins are a HOLD', () => {
		const reader = realReader(w, READ_AT, (_c, e) => void (e.pins = { ...e.pins, artifact: `sha256:${hex('9', 64)}` }));
		hold(bind(w, { reader }), /pin/i);
	});

	test('a pin that is not the hash of the staged target.json or wrangler.jsonc is a HOLD even when the evidence echoes the same wrong pin', () => {
		const wrong = sha('not the reviewed bytes');
		hold(bind(w, lying(w, 'client-a', forge(w, 'client-a', { pins: { target: wrong } }))), /target\.json bytes .* not the external pin target/);
		hold(bind(w, lying(w, 'client-a', forge(w, 'client-a', { pins: { config: wrong } }))), /wrangler\.jsonc bytes .* not the external pin config/);
		hold(bind(w, lying(w, 'client-a', forge(w, 'client-a', { pins: { migrations: wrong } }))), /migrations/);
		hold(bind(w, lying(w, 'client-a', forge(w, 'client-a', { pins: { source: '8'.repeat(40) } }))), /source/);
	});

	test('pins that match a forged stage but not the observed manifest cannot bind it', () => {
		const f = forge(w, 'client-a', { target: (t) => (t.runtime.sourceSha = '9'.repeat(40)), pins: { source: '9'.repeat(40) } });
		hold(bind(w, lying(w, 'client-a', f)), /source|version/i);
	});

	test('no profile revision pin, or one the manifest never observed, is a HOLD', () => {
		hold(bind(w, { profileRevision: undefined as unknown as string }), /profile/i);
		hold(bind(w, { profileRevision: 'd'.repeat(40) }), /profile/i);
		hold(bind(w, { profileRevision: 'main' }), /profile/i);
	});
});

describe('old schema, no legacy conversion', () => {
	const w = world();
	const legacy = (client: string) => (s: string) => {
		const r = JSON.parse(s);
		return `${JSON.stringify({ schema: 'clearcase.deploy-stage/1', client, files: r.files, artifact: r.artifact, migrations: r.migrations }, null, 2)}\n`;
	};

	test('a legacy deploy-stage/1 record is refused and is never converted, even from a reader that reports no problems', () => {
		const f = forge(w, 'client-a', { stageText: legacy('client-a') });
		hold(bind(w, lying(w, 'client-a', f)), /legacy clearcase\.deploy-stage\/1 record: refused.*never converted/);
	});

	test('the legacy controller binder stays legacy-only and refuses the native record (the incompatibility is explicit, not papered over)', () => {
		const stageJson = readFileSync(path.join(w.stages['client-a']!, 'stage.json'), 'utf8');
		const manifest = parseNativeManifest(w.manifest);
		expect(bindStageRecord(manifest, 'client-a', stageJson).join('\n')).toMatch(/deploy-stage\/1/);
	});

	test('an unknown evidence or record schema, an old evidence schema and a missing checker label are refused', () => {
		hold(bind(w, { reader: realReader(w, READ_AT, (_c, e) => void ((e as any).schema = 'clearcase.native-stage-evidence/0')) }), /schema/i);
		hold(bind(w, { reader: realReader(w, READ_AT, (_c, e) => void ((e as any).checker = 'checkPrebuilt')) }), /checker/i);
		const f = forge(w, 'client-a', { record: (r) => (r.schema = 'clearcase.deploy-stage.native/2') });
		hold(bind(w, lying(w, 'client-a', f)), /schema|record|stage\.json/i);
	});
});

describe('dropped upload record', () => {
	const w = world();

	test('a real stage whose stage.json lost its upload section is refused by the real checker and bound as a HOLD', () => {
		const dir = copy(w.stages['client-a']!);
		editJson(path.join(dir, 'stage.json'), (r) => delete r.upload);
		hold(bind({ ...w, stages: { ...w.stages, 'client-a': dir } }), /upload|record|stage\.json/i);
	});

	test('without a real checker the binder still refuses a record with no upload section, an empty file list, or an entry that is not a listed file', () => {
		const drop = (f: (r: Record<string, any>) => void) => hold(bind(w, lying(w, 'client-a', forge(w, 'client-a', { record: f }))), /upload|record/i);
		drop((r) => delete r.upload);
		drop((r) => (r.upload.files = []));
		drop((r) => (r.upload.files = r.upload.files.filter((x: any) => x.path !== 'artifact/cloudflare/_worker.js')));
		drop((r) => (r.upload.hostImports = ['node:fs']));
		drop((r) => (r.upload.additionalModules = true));
		drop((r) => (r.upload.invocation = ['wrangler', 'deploy', '--name', 'cc-sbx-b-20261023']));
	});

	test('the canary asset the manifest observed must be a staged upload file with the same bytes', () => {
		const m = clone(w.manifest);
		m.clients[0]!.canary.assetPath = '/_app/not-in-the-stage.js';
		hold(bind(w, { observed: { manifest: m, readback: readbackFor(m) } }), /asset|canary/i);
		const h = clone(w.manifest);
		h.clients[0]!.canary.assetSha256 = `sha256:${hex('a', 64)}`;
		hold(bind(w, { observed: { manifest: h, readback: readbackFor(h) } }), /asset|canary/i);
	});
});

describe('observed manifest drift (domain and version IDs only come from the observation)', () => {
	const w = world();
	const drift: [string, (c: any) => void, RegExp][] = [
		['hostname', (c) => (c.domain.hostname = 'b.sandbox.gridshift.co.za'), /hostname|manifest/i],
		['D1 id', (c) => (c.d1.id = OTHER_UUID), /d1/i],
		['R2 bucket', (c) => (c.r2.bucket = 'cc-sbx-b-20261023-files'), /r2|bucket|manifest/i],
		['extra secret', (c) => c.secretNames.push('CLERK_PUBLISHABLE_KEY'), /secret/i],
		['missing secret', (c) => (c.secretNames = []), /secret/i],
		['source', (c) => (c.release.sourceSha = '1'.repeat(40)), /source/i],
		['domain zone', (c) => (c.domain.zoneId = hex('f')), /zone|manifest/i],
		['profile revision', (c) => (c.release.profileRevision = 'e'.repeat(40)), /profile/i],
	];
	for (const [what, edit, reason] of drift)
		test(`${what} observed differently from the stage is a HOLD`, () => {
			const m = clone(w.manifest);
			edit(m.clients[0]);
			hold(bind(w, { observed: { manifest: m, readback: readbackFor(m) } }), reason);
		});

	test('another account or zone in the manifest is refused', () => {
		const m = clone(w.manifest);
		m.accountId = hex('a');
		hold(bind(w, { observed: { manifest: m, readback: readbackFor(m) } }), /account|manifest/i);
	});

	test('an unreadable manifest or a manifest with no readback is a HOLD with nothing bound', () => {
		hold(bind(w, { observed: { manifest: null as unknown as NativeManifest, readback: readbackFor(w.manifest) } }), /manifest/i);
		hold(bind(w, { observed: { manifest: w.manifest, readback: undefined as unknown as ProviderReadback } }), /readback/i);
		hold(bind(w, { observed: undefined as unknown as BindInput['observed'] }), /observed|manifest/i);
	});

	test('a readback that does not show the manifest state (a missing domain, a different D1) is a HOLD', () => {
		const rb = readbackFor(w.manifest);
		rb.domains = [];
		hold(bind(w, { observed: { manifest: w.manifest, readback: rb } }), /domain|readback|bound/i);
		const rb2 = readbackFor(w.manifest);
		rb2.d1[0]!.id = OTHER_UUID;
		hold(bind(w, { observed: { manifest: w.manifest, readback: rb2 } }), /d1|readback/i);
	});

	test('the manifest the binder judged is copied before the first read: a later edit by the caller changes nothing', () => {
		const m = clone(w.manifest);
		const res = bind(w, {
			observed: { manifest: m, readback: readbackFor(m) },
			reader: realReader(w, READ_AT, () => void (m.clients[0]!.d1.id = OTHER_UUID)),
		});
		expect(res.state).toBe('BOUND-STRUCTURAL');
	});
});

describe('stale, future and unrevalidated evidence', () => {
	const w = world();

	test('stage evidence older than the bound, future-dated, non-finite or missing its read time is a HOLD', () => {
		hold(bind(w, { reader: realReader(w, NOW - 400_000) }), /stale|old|read/i);
		hold(bind(w, { reader: realReader(w, NOW + 10) }), /future|read/i);
		hold(bind(w, { reader: realReader(w, Number.NaN) }), /read/i);
		hold(bind(w, { reader: realReader(w, undefined as unknown as number, (_c, e) => void delete (e as any).readAt) }), /read|key/i);
	});

	test('a stale or future provider readback is a HOLD', () => {
		const stale = readbackFor(w.manifest);
		stale.observedAt = NOW - 120_000;
		hold(bind(w, { observed: { manifest: w.manifest, readback: stale } }), /stale|future|readback/i);
		const future = readbackFor(w.manifest);
		future.observedAt = NOW + 1;
		hold(bind(w, { observed: { manifest: w.manifest, readback: future } }), /stale|future|readback/i);
	});

	test('a missing or non-finite clock is a HOLD', () => {
		hold(bind(w, { now: undefined as unknown as () => number }), /clock|now/i);
		hold(bind(w, { now: () => Number.NaN }), /clock|now/i);
	});

	test('revalidation: bytes that change between the first and the second read are a HOLD, whichever file changed', () => {
		for (const key of ['stageJson', 'targetJson', 'configJsonc'] as const) {
			let reads = 0;
			const reader: NativeStageReader = {
				read: (c) => {
					const e = realReader(w).read(c);
					if (c === 'client-a' && ++reads === 2) e.files[key] = `${e.files[key]} `;
					return e;
				},
			};
			hold(bind(w, { reader }), /changed|revalid|differs/i);
		}
	});

	test('revalidation: a checker problem that appears only on the second read, or a read time that goes backwards, is a HOLD', () => {
		let reads = 0;
		const late: NativeStageReader = { read: (c) => ({ ...realReader(w).read(c), problems: c === 'client-a' && ++reads === 2 ? ['stage changed after the first check'] : [] }) };
		hold(bind(w, { reader: late }), /stage changed|revalid|changed/i);
		let calls = 0;
		const back: NativeStageReader = { read: (c) => ({ ...realReader(w, c === 'client-a' && ++calls === 2 ? READ_AT - 100 : READ_AT).read(c) }) };
		hold(bind(w, { reader: back }), /backwards|revalid|read time/i);
	});
});

describe('no caller boolean is proof: checked-owner evidence only', () => {
	const w = world();

	test('evidence that carries a caller label (checked, ok, verified) is refused as an unread key', () => {
		for (const k of ['checked', 'ok', 'verified', 'providerProof']) hold(bind(w, { reader: realReader(w, READ_AT, (_c, e) => void ((e as any)[k] = true)) }), /key|checked|read/i);
	});

	test('evidence with problems, a non-array or non-string problems, or no problems field is a HOLD', () => {
		hold(bind(w, { reader: realReader(w, READ_AT, (_c, e) => void e.problems.push('the stage is not built from the reviewed source')) }), /not built from the reviewed source/);
		hold(bind(w, { reader: realReader(w, READ_AT, (_c, e) => void ((e as any).problems = true)) }), /problems/i);
		hold(bind(w, { reader: realReader(w, READ_AT, (_c, e) => void ((e as any).problems = [1])) }), /problems/i);
		hold(bind(w, { reader: realReader(w, READ_AT, (_c, e) => void delete (e as any).problems) }), /problems|key/i);
	});

	test('a reader that is a bare boolean, a function, throws or returns a non-object is a HOLD', () => {
		hold(bind(w, { reader: true as unknown as NativeStageReader }), /reader/i);
		hold(bind(w, { reader: { read: () => true as unknown as NativeStageEvidence } }), /evidence|object/i);
		hold(bind(w, { reader: { read: () => null as unknown as NativeStageEvidence } }), /evidence|object/i);
		hold(bind(w, { reader: { read: () => { throw new Error('boom'); } } }), /boom|read/i);
	});

	test('evidence files that are not text are refused', () => {
		hold(bind(w, { reader: realReader(w, READ_AT, (_c, e) => void ((e.files as any).targetJson = Buffer.from('{}'))) }), /files|text|string/i);
	});

	test('a stored JSON record or a synthetic receipt label is structural only and re-judges as not issued', () => {
		const good = bind(w);
		expect(nativeBindingProblems(good)).toEqual([]);
		const stored = JSON.parse(JSON.stringify(good));
		refusedWith(nativeBindingProblems(stored), /not issued|stored|label/i);
		for (const k of ['providerProof', 'controlReady', 'funded'] as const) {
			const t = clone(stored);
			t[k] = true;
			refusedWith(nativeBindingProblems(t), /not issued|stored|label|false/i);
		}
		refusedWith(nativeBindingProblems({ ...good }), /not issued|stored|label/i);
		refusedWith(nativeBindingProblems(null), /not issued|stored|label|object/i);
		refusedWith(nativeBindingProblems('BOUND-STRUCTURAL'), /not issued|stored|label|object/i);
	});

	test('a HOLD result is never judged as bound, and its flags stay false', () => {
		const held = bind(w, { pins: {} });
		expect(held.providerProof).toBe(false);
		expect(held.controlReady).toBe(false);
		expect(held.funded).toBe(false);
		refusedWith(nativeBindingProblems(held), /HOLD|not bound/i);
	});

	test('a satisfied binding never sets the flags: a claim in the evidence cannot change them', () => {
		const f = forge(w, 'client-a', { record: (r) => ((r.providerProof = true), (r.controlsProof = true)) });
		const res = bind(w, lying(w, 'client-a', f));
		expect(res.providerProof).toBe(false);
		expect(res.controlReady).toBe(false);
		expect(res.funded).toBe(false);
		expect(res.state).toBe('HOLD');
	});
});

describe('the hashing the binder does itself', () => {
	test('the pure SHA-256 equals node:crypto for block-boundary, multi-block and non-ASCII text', () => {
		const samples = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65), 'a'.repeat(1000), 'é€😀 stage.json\n', JSON.stringify({ a: [1, 2, 3] }).repeat(300)];
		for (const s of samples) expect(sha256Text(s), JSON.stringify(s.slice(0, 20))).toBe(sha(s));
		expect(sha256Text('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	});
});

describe('boundaries of the module', () => {
	const source = readFileSync(MODULE, 'utf8');

	test('it reads no file, environment, network, process or clock and is not a legacy adapter', () => {
		for (const bad of [/node:fs/, /node:child_process/, /node:net|node:http|node:dns/, /\bfetch\s*\(/, /process\./, /Date\.now|new Date|performance\.now/, /setTimeout|setInterval/, /deploy\/probes\/target/, /bindStageRecord\s*\(/])
			expect(source, String(bad)).not.toMatch(bad);
	});

	test('it never builds a legacy stage record: the legacy schema appears only as a refusal', () => {
		const uses = source.split('\n').filter((l) => l.includes('deploy-stage/1'));
		for (const l of uses) expect(l, l).toMatch(/refus|legacy|never|not|\bif\b|===|!==|includes/i);
	});

	test('the DNS and certificate policy, the stop plan and the canary contract are not reachable from the binder', () => {
		expect(source).not.toMatch(/domainDetachPolicy|stopNativeAlpha|checkNegativeProof|dispatch\s*\(/);
	});

	test('a fixture directory listing sanity check: the shared stage inputs are the synthetic copies only', () => {
		expect(readdirSync(FIXTURES).sort()).toEqual(['artifact', 'clients']);
	});
});
