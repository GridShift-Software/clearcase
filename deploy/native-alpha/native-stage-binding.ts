// Strict binding of a VERIFIED native prebuilt stage (target -> stage -> prebuilt, pipeline.ts) and its independently
// reviewed external pins to the OBSERVED native ControlManifest (controls.ts), per client and as a bound set. A NEW
// binder: it never reads, writes or converts the legacy `clearcase.deploy-stage/1` record that the controller's
// `bindStageRecord` accepts, and nothing here is forged to look like one. The controller stays legacy-only; the parent
// calls `bindNativeStages` beside it (see docs/acceptance/hosting/native-stage-binding.md for the exact hook).
//
// What it judges is DATA handed to it. It reads no file, environment, network, process, credential or clock of its own:
//   - `observed`: the ControlManifest (parseNativeManifest, copied and frozen before anything else is read) and a fresh
//     provider readback that must show that manifest (readbackProblems 'before'). Domain IDs, Workers version IDs and the
//     other provider-assigned identifiers come ONLY from here; a target or stage that carries one is already refused by
//     pipeline.ts.
//   - `pins`: the six external reviewed pins per client (NativePins) and the reviewed profile revision. They are the
//     root of trust and are never taken from the stage or from the evidence: the evidence echoes the pins its checker was
//     given, and any difference from the supplied pins is a HOLD.
//   - `reader`: the checked-owner evidence reader. Its evidence is what the owner's real checkNativeStage returned
//     (its problems list, which must be empty) together with the stage.json, target.json and wrangler.jsonc bytes of the
//     SAME stage as text. A caller-asserted boolean ("checked", "ok", "verified") is an unread key and a HOLD. The
//     reader is called twice per client (revalidation): the second evidence must equal the first byte for byte, and
//     every evidence is copied and frozen on receipt.
//
// Independent re-derivation. The binder does not trust the checker's emptiness alone: from the evidence texts and the
// pins it re-hashes target.json and wrangler.jsonc against the pins, re-parses the target, re-checks the config against
// every bound target (checkNativeWrangler, so another client's identifier is refused), requires the record's upload
// section (entry by hash, every uploaded file, closed host imports, `additionalModules:false`, the exact upload
// command), rebuilds the whole native stage record from those facts and the PINNED artifact, migrations and entry
// digests and requires it byte for byte, and compares each fact the manifest observed (account, zone, client, Worker,
// custom-domain hostname and zone, service, D1 name/UUID/jurisdiction, private EU R2, secret inventory, source,
// artifact, profile revision and the original asset canary against the staged file of the same path). What it cannot
// re-derive from text (the artifact and migrations tree digests, `_app/version.json`) it takes from the owner's checker
// problems list and the external pins; a reader that lies about those and about nothing else is NOT refused here. That
// residual trust is why the result is structural only and why the unforgeable origin of the evidence is a named hook
// on the bundle/parent owner (the acceptance document).
//
// Result: a frozen record that only this module issues. providerProof, controlReady and funded are constant false; a
// stored JSON copy, a spread copy or a label is structural data that nativeBindingProblems refuses as not issued. The
// binding carries no grant, permission, approval or allowance of any kind, and it touches no DNS, certificate, stop,
// canary or negative-proof policy: those stay in controls.ts, default UNKNOWN, with no remote action here.
import { parseNativeManifest, readbackProblems, type NativeManifest, type ProviderReadback } from './controls.ts';
import {
	NATIVE_CLIENT_FILES,
	NATIVE_CONFIG_FILE,
	NATIVE_HOST_IMPORTS,
	NATIVE_DYNAMIC_HOST_IMPORTS,
	NATIVE_ADAPTER_HEADERS,
	nativeArtifactLayout,
	type DynamicHostImport,
	NATIVE_STAGE_SCHEMA,
	NATIVE_STAGED,
	NATIVE_UPLOAD_ARGV,
	checkNativeWrangler,
	distinctNative,
	nativeStageRecord,
	nativeUpload,
	parseNativeJson,
	parseNativePins,
	parseNativeTarget,
	type NativePins,
	type NativeTarget,
	type UploadFile,
} from './pipeline.ts';

export const NATIVE_STAGE_EVIDENCE_SCHEMA = 'clearcase.native-stage-evidence/1' as const;
export const NATIVE_STAGE_BINDING_SCHEMA = 'clearcase.native-stage-binding/1' as const;
/** How old a stage evidence read may be when it is judged. */
export const STAGE_EVIDENCE_MAX_AGE_MS = 300_000;
/** The only checker whose emptiness an evidence may report. */
export const NATIVE_STAGE_CHECKER = 'checkNativeStage' as const;
const LEGACY_STAGE_SCHEMA = 'clearcase.deploy-stage/1';

/** What the owner's real checkNativeStage returned for `client`, plus the bytes of the same stage, read on `readAt` (the caller's clock). Data, not trust. */
export type NativeStageEvidence = {
	schema: typeof NATIVE_STAGE_EVIDENCE_SCHEMA;
	checker: typeof NATIVE_STAGE_CHECKER;
	client: string;
	/** The external pins the checker was given; compared with the supplied pins, never used in their place. */
	pins: NativePins;
	/** checkNativeStage's own return value: empty means the owner found nothing to refuse. */
	problems: string[];
	readAt: number;
	files: { stageJson: string; targetJson: string; configJsonc: string };
};
export type NativeStageReader = { read(client: string): NativeStageEvidence };
export type BindInput = {
	observed: { manifest: NativeManifest; readback: ProviderReadback };
	/** Per client, from the reviewed record and never from the stage. */
	pins: Record<string, NativePins>;
	/** The reviewed native profile revision (40-hex) the manifest must have been observed under. */
	profileRevision: string;
	reader: NativeStageReader;
	now: () => number;
};

export type BoundClient = {
	client: string;
	accountId: string;
	zoneId: string;
	worker: string;
	hostname: string;
	domainId: string;
	d1Id: string;
	r2Bucket: string;
	versionIds: string[];
	secretNames: string[];
	sourceSha: string;
	artifactSha256: string;
	profileRevision: string;
	targetSha256: string;
	configSha256: string;
	entrySha256: string;
	stageSha256: string;
	readAt: number;
};
export type NativeBindingResult = {
	schema: typeof NATIVE_STAGE_BINDING_SCHEMA;
	state: 'HOLD' | 'BOUND-STRUCTURAL';
	problems: string[];
	bound: BoundClient[];
	/** Always true: the binding is a local structural comparison. */
	structuralOnly: true;
	providerProof: false;
	controlReady: false;
	funded: false;
	/** Always false: nothing here reads, writes or converts a legacy stage record. */
	legacyConversion: false;
};

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const EVIDENCE_KEYS = ['schema', 'checker', 'client', 'pins', 'problems', 'readAt', 'files'] as const;
const FILE_KEYS = ['stageJson', 'targetJson', 'configJsonc'] as const;
const UPLOAD_KEYS = ['mode', 'bundler', 'entry', 'hostImports', 'dynamicHostImports', 'additionalModules', 'assets', 'files', 'invocation'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const show = (v: unknown) => (v === undefined ? 'missing' : JSON.stringify(v));

const K256 = Uint32Array.from([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
/**
 * SHA-256 of the UTF-8 bytes of `text` as `sha256:<hex>`: FIPS 180-4, pure computation, so this module needs no host
 * module (the tests compare it with node:crypto). It hashes text because the evidence carries the staged files as text.
 */
export function sha256Text(text: string): string {
	const data = new TextEncoder().encode(text);
	const total = Math.ceil((data.length + 9) / 64) * 64;
	const buf = new Uint8Array(total);
	buf.set(data);
	buf[data.length] = 0x80;
	const view = new DataView(buf.buffer);
	view.setUint32(total - 8, Math.floor((data.length * 8) / 0x100000000));
	view.setUint32(total - 4, (data.length * 8) >>> 0);
	const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
	const w = new Uint32Array(64);
	const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
	for (let off = 0; off < total; off += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
			const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
			w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
		for (let i = 0; i < 64; i++) {
			const t1 = (hh! + (rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)) + ((e! & f!) ^ (~e! & g!)) + K256[i]! + w[i]!) >>> 0;
			const t2 = ((rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)) + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) >>> 0;
			hh = g;
			g = f;
			f = e;
			e = (d! + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}
		[a, b, c, d, e, f, g, hh].forEach((v, i) => (h[i] = (h[i]! + v!) >>> 0));
	}
	return `sha256:${[...h].map((x) => x.toString(16).padStart(8, '0')).join('')}`;
}
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const sha256 = sha256Text;
/** A JSON copy: drops functions, getters and prototypes so a reader or caller cannot keep a live handle on what is judged. */
const snapshot = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function deepFreeze<T>(value: T): T {
	if (typeof value === 'object' && value !== null) {
		for (const v of Object.values(value)) deepFreeze(v);
		Object.freeze(value);
	}
	return value;
}
/** The text of `evidence` without its read time, so two reads compare on content only. */
const content = (e: NativeStageEvidence) => JSON.stringify({ ...e, readAt: 0, pins: Object.fromEntries(Object.entries(e.pins).sort()), files: e.files });

/** Results this module issued in this process; a stored JSON copy, a spread copy or a hand-built label is never in it. */
const ISSUED = new WeakSet<object>();
function issue(state: NativeBindingResult['state'], problems: string[], bound: BoundClient[] = []): NativeBindingResult {
	const out = deepFreeze(snapshot({ schema: NATIVE_STAGE_BINDING_SCHEMA as typeof NATIVE_STAGE_BINDING_SCHEMA, state, problems, bound: state === 'BOUND-STRUCTURAL' ? bound : [], structuralOnly: true as const, providerProof: false as const, controlReady: false as const, funded: false as const, legacyConversion: false as const }));
	ISSUED.add(out);
	return out;
}

/** Problems with one evidence read as DATA: its shape only. A copy of the evidence is returned when it is well formed. */
function evidenceShape(raw: unknown, client: string, pins: NativePins, now: number, at: string): { evidence?: NativeStageEvidence; problems: string[] } {
	const problems: string[] = [];
	const fail = (m: string) => problems.push(`${at}: ${m}`);
	if (!isObject(raw)) return { problems: [`${at}: the evidence is not an object (a boolean or label is not checked-owner evidence)`] };
	let e: Record<string, unknown>;
	try {
		e = snapshot(raw);
	} catch (err) {
		return { problems: [`${at}: the evidence cannot be copied: ${(err as Error).message}`] };
	}
	for (const k of Object.keys(e)) if (!(EVIDENCE_KEYS as readonly string[]).includes(k)) fail(`evidence key ${k} is not read: a caller label such as checked, ok or verified is not proof`);
	for (const k of EVIDENCE_KEYS) if (!Object.hasOwn(e, k)) fail(`evidence key ${k} is missing`);
	if (e.schema !== NATIVE_STAGE_EVIDENCE_SCHEMA) fail(`evidence schema ${show(e.schema)} is not ${NATIVE_STAGE_EVIDENCE_SCHEMA}`);
	if (e.checker !== NATIVE_STAGE_CHECKER) fail(`evidence checker ${show(e.checker)} is not ${NATIVE_STAGE_CHECKER}`);
	if (e.client !== client) fail(`evidence is for ${show(e.client)}, not ${client}`);
	const given = parseNativePins(e.pins);
	if (!given.pins) fail(`the evidence pins are not the six external pins: ${given.problems.join('; ')}`);
	else if (JSON.stringify(Object.entries(given.pins).sort()) !== JSON.stringify(Object.entries(pins).sort())) fail('the pins the checker was given are not the external pins supplied to the binder (a pin read from the stage is not external)');
	if (!Array.isArray(e.problems) || !e.problems.every((p) => typeof p === 'string')) fail(`evidence problems ${show(e.problems)} is not a list of strings`);
	else for (const p of e.problems) fail(`the owner's checkNativeStage refused the stage: ${p}`);
	if (typeof e.readAt !== 'number' || !Number.isFinite(e.readAt)) fail(`evidence read time ${show(e.readAt)} is not a finite number`);
	else if (e.readAt > now) fail(`evidence read time ${e.readAt} is in the future of ${now}`);
	else if (now - e.readAt > STAGE_EVIDENCE_MAX_AGE_MS) fail(`evidence read time ${e.readAt} is stale (older than ${STAGE_EVIDENCE_MAX_AGE_MS} ms before ${now})`);
	const f = e.files;
	if (!isObject(f) || Object.keys(f).length !== FILE_KEYS.length || !FILE_KEYS.every((k) => typeof f[k] === 'string')) fail(`evidence files ${isObject(f) ? show(Object.keys(f)) : show(f)} are not exactly the text of ${FILE_KEYS.join(', ')}`);
	return problems.length ? { problems } : { evidence: e as unknown as NativeStageEvidence, problems };
}

/** The staged upload section as DATA, with every problem found; `files` and `entry` come back only when well formed. */
function uploadFacts(record: Record<string, unknown>, pins: NativePins, at: string, flags: readonly string[]): { problems: string[]; upload?: ReturnType<typeof nativeUpload> } {
	const problems: string[] = [];
	const fail = (m: string) => problems.push(`${at}: ${m}`);
	const u = record.upload;
	if (!isObject(u)) return { problems: [`${at}: the stage record has no upload section (the actual final upload bytes are not recorded), so the stage cannot be bound`] };
	if (Object.keys(u).length !== UPLOAD_KEYS.length || !UPLOAD_KEYS.every((k) => Object.hasOwn(u, k))) fail(`stage record upload keys ${show(Object.keys(u))} are not exactly ${show(UPLOAD_KEYS)}`);
	const entry = u.entry;
	let entryOk = false;
	if (!isObject(entry) || Object.keys(entry).length !== 3 || entry.path !== NATIVE_STAGED.entry || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256) || !Number.isInteger(entry.bytes) || (entry.bytes as number) < 0) fail(`stage record upload.entry ${show(entry)} is not exactly { path: ${NATIVE_STAGED.entry}, sha256, bytes }`);
	else {
		entryOk = true;
		if (entry.sha256 !== pins.entry) fail(`upload entry hash ${entry.sha256} is not the external entry pin ${pins.entry}`);
	}
	const files: UploadFile[] = [];
	if (!Array.isArray(u.files) || u.files.length === 0) fail('stage record upload.files is empty or not a list: every uploaded file must be named by its own hash');
	else {
		const seen = new Set<string>();
		for (const f of u.files) {
			if (!isObject(f) || Object.keys(f).length !== 3 || typeof f.path !== 'string' || !f.path.startsWith('artifact/') || f.path.includes('\\') || f.path.split('/').some((s) => !s || s === '.' || s === '..') || typeof f.sha256 !== 'string' || !SHA256.test(f.sha256) || !Number.isInteger(f.bytes) || (f.bytes as number) < 0) fail(`stage record upload file ${show(f)} is not exactly { path under artifact/, bytes, sha256 }`);
			else if (seen.has(f.path)) fail(`stage record upload file ${f.path} is listed twice`);
			else (seen.add(f.path), files.push({ path: f.path, bytes: f.bytes as number, sha256: f.sha256 }));
		}
		if (entryOk) {
			const listed = files.find((f) => f.path === NATIVE_STAGED.entry);
			if (!listed || listed.sha256 !== (entry as Record<string, unknown>).sha256 || listed.bytes !== (entry as Record<string, unknown>).bytes) fail(`the upload entry ${NATIVE_STAGED.entry} is not a listed upload file with the same hash and size`);
		}
	}
	const hosts = u.hostImports;
	if (!Array.isArray(hosts) || !hosts.every((h) => typeof h === 'string' && (NATIVE_HOST_IMPORTS as readonly string[]).includes(h))) fail(`stage record upload.hostImports ${show(hosts)} is not a list within ${NATIVE_HOST_IMPORTS.join(', ')}`);
	const dynamic: DynamicHostImport[] = [];
	if (!Array.isArray(u.dynamicHostImports)) fail('stage record upload.dynamicHostImports is not a list');
	else {
		const seen = new Set<string>();
		for (const d of u.dynamicHostImports) {
			if (!isObject(d) || Object.keys(d).length !== 3 || typeof d.specifier !== 'string' || !Object.hasOwn(NATIVE_DYNAMIC_HOST_IMPORTS, d.specifier) || typeof d.via !== 'string' || !/^(literal|forwarder [A-Za-z_$][\w$]*)$/.test(d.via) || !Number.isSafeInteger(d.sites) || (d.sites as number) <= 0) {
				fail(`stage record upload.dynamicHostImports fact ${show(d)} is invalid`);
				continue;
			}
			if (!NATIVE_DYNAMIC_HOST_IMPORTS[d.specifier]!.some((f) => flags.includes(f))) fail(`dynamic host import ${d.specifier} has no required compatibility flag`);
			const key = JSON.stringify([d.specifier, d.via]);
			if (seen.has(key)) fail(`dynamic host import ${key} is listed twice`);
			seen.add(key);
			dynamic.push({ specifier: d.specifier, via: d.via, sites: d.sites as number });
		}
	}
	const headers = files.find((f) => f.path === `${NATIVE_STAGED.assets}/_headers`);
	const headerMatches = headers?.sha256 === sha256(NATIVE_ADAPTER_HEADERS) && headers.bytes === new TextEncoder().encode(NATIVE_ADAPTER_HEADERS).length;
	const layout = nativeArtifactLayout({ files, entrySha256: pins.entry, headersText: headerMatches ? NATIVE_ADAPTER_HEADERS : null });
	problems.push(...layout.problems.map((p) => `${at}: ${p}`));
	if (JSON.stringify(u.assets) !== JSON.stringify(layout.assets)) fail('stage record upload.assets is not the exact public asset and header inventory of upload.files');
	if (u.additionalModules !== false) fail(`stage record upload.additionalModules is ${show(u.additionalModules)}, not false`);
	if (!Array.isArray(u.invocation) || u.invocation.length !== NATIVE_UPLOAD_ARGV.length || !NATIVE_UPLOAD_ARGV.every((x, i) => (u.invocation as unknown[])[i] === x)) fail(`stage record upload.invocation ${show(u.invocation)} is not exactly ${JSON.stringify(NATIVE_UPLOAD_ARGV)}`);
	if (problems.length) return { problems };
	const upload = nativeUpload({ entry: { sha256: (entry as Record<string, unknown>).sha256 as string, bytes: (entry as Record<string, unknown>).bytes as number }, hostImports: u.hostImports as string[], dynamicHostImports: dynamic, assets: layout.assets, files });
	return { problems, upload };
}

type Judged = { client: string; target?: NativeTarget; evidence: NativeStageEvidence; upload?: ReturnType<typeof nativeUpload>; stageSha256: string };

/**
 * Binds every client of the observed manifest to its verified native stage, or returns HOLD with every reason found and
 * nothing bound. Synchronous: the reader is the owner's checked evidence, called twice per client. See the module note.
 */
export function bindNativeStages(a: BindInput): NativeBindingResult {
	const hold = (problems: string[]) => issue('HOLD', problems);
	if (!isObject(a)) return hold(['the binding input is not an object']);
	if (typeof a.now !== 'function') return hold(['no injected now(): this module has no clock of its own']);
	const reading = (what: string): number | string => {
		let v: unknown;
		try {
			v = a.now();
		} catch (e) {
			return `the clock threw at ${what}: ${(e as Error).message}`;
		}
		return typeof v === 'number' && Number.isFinite(v) ? v : `the clock returned ${show(v)} at ${what}`;
	};
	const t0 = reading('the start');
	if (typeof t0 === 'string') return hold([t0]);

	// 1. The observed side, copied before anything else is read.
	const obs = a.observed;
	if (!isObject(obs)) return hold(['no observed ControlManifest and provider readback: nothing can be bound to an unobserved release']);
	let manifest: NativeManifest;
	try {
		manifest = parseNativeManifest(obs.manifest);
	} catch (e) {
		return hold([`observed manifest refused: ${(e as Error).message}`]);
	}
	if (!isObject(obs.readback)) return hold(['no provider readback of the observed manifest: a manifest without a fresh readback is not observed state']);
	let readback: ProviderReadback;
	try {
		readback = snapshot(obs.readback);
	} catch (e) {
		return hold([`the provider readback cannot be copied: ${(e as Error).message}`]);
	}
	const problems: string[] = [];
	problems.push(...readbackProblems(manifest, readback, t0, 'before').map((p) => `readback ${p}`));

	// 2. The external side: the reviewed profile revision and the six pins per client.
	if (typeof a.profileRevision !== 'string' || !SHA40.test(a.profileRevision)) problems.push(`the reviewed profile revision ${show(a.profileRevision)} is required and must be a 40-hex commit`);
	const names = manifest.clients.map((c) => c.client);
	const pins: Record<string, NativePins> = {};
	if (!isObject(a.pins)) problems.push('the external pins are required for every client and are never read from the stage; none were given');
	else {
		for (const k of Object.keys(a.pins)) if (!names.includes(k)) problems.push(`pins name ${show(k)}, which is not a client of the observed manifest`);
		for (const c of names) {
			const parsed = parseNativePins((a.pins as Record<string, unknown>)[c]);
			if (!parsed.pins) problems.push(`no valid external pins for ${c}: ${parsed.problems.join('; ')}`);
			else pins[c] = snapshot(parsed.pins);
		}
	}
	if (!isObject(a.reader) || typeof a.reader.read !== 'function') problems.push('no checked-owner evidence reader (an object with read(client)): a caller boolean or label is not evidence');
	if (problems.length) return hold(problems);
	const reader = a.reader;

	// 3. First read of every client's evidence, judged as data.
	const first = new Map<string, NativeStageEvidence>();
	const pass = (n: number, now: number): Map<string, NativeStageEvidence> => {
		const out = new Map<string, NativeStageEvidence>();
		for (const client of names) {
			let raw: unknown;
			try {
				raw = reader.read(client);
			} catch (e) {
				problems.push(`${client}: stage evidence unreadable${n === 2 ? ' on revalidation' : ''}: ${(e as Error).message}`);
				continue;
			}
			const shaped = evidenceShape(raw, client, pins[client]!, now, `${client}${n === 2 ? ' (revalidation)' : ''}`);
			problems.push(...shaped.problems);
			if (shaped.evidence) out.set(client, deepFreeze(shaped.evidence));
		}
		return out;
	};
	for (const [c, e] of pass(1, t0)) first.set(c, e);

	// 4. Judge each client's evidence against the pins, the other targets and the observation.
	const judged: Judged[] = [];
	const targets: NativeTarget[] = [];
	for (const client of names) {
		const e = first.get(client);
		if (!e) continue;
		const at = client;
		const p = pins[client]!;
		const j: Judged = { client, evidence: e, stageSha256: sha256(e.files.stageJson) };
		judged.push(j);
		let target: NativeTarget | undefined;
		try {
			target = parseNativeTarget(parseNativeJson(e.files.targetJson), `${at} target.json`);
			if (target.client !== client) throw new Error(`target.json names ${target.client}, not ${client}`);
		} catch (err) {
			problems.push(`${at}: the staged target.json is refused: ${(err as Error).message}`);
		}
		if (sha256(e.files.targetJson) !== p.target) problems.push(`${at}: target.json bytes ${sha256(e.files.targetJson)} are not the external pin target ${p.target}`);
		if (sha256(e.files.configJsonc) !== p.config) problems.push(`${at}: wrangler.jsonc bytes ${sha256(e.files.configJsonc)} are not the external pin config ${p.config}`);
		if (target) {
			j.target = target;
			targets.push(target);
			const r = target.runtime;
			if (r.artifactSha256 !== p.artifact) problems.push(`${at}: the target's artifact ${r.artifactSha256} is not the external artifact pin ${p.artifact}`);
			if (r.migrationsSha256 !== p.migrations) problems.push(`${at}: the target's migrations ${r.migrationsSha256} are not the external migrations pin ${p.migrations}`);
			if (r.sourceSha !== p.source) problems.push(`${at}: the target's source ${r.sourceSha} is not the external source pin ${p.source}`);
		}
	}
	try {
		distinctNative(targets);
	} catch (e) {
		problems.push(`the bound set shares an identifier: ${(e as Error).message}`);
	}
	for (const j of judged) {
		const e = j.evidence;
		const at = j.client;
		const p = pins[j.client]!;
		if (j.target) for (const m of checkNativeWrangler({ client: j.client, targets, text: e.files.configJsonc })) problems.push(`${at}: ${NATIVE_CONFIG_FILE}: ${m}`);
		// The stage record, as data.
		let record: unknown;
		try {
			record = parseNativeJson(e.files.stageJson);
		} catch (err) {
			problems.push(`${at}: stage.json cannot be read as strict JSON: ${(err as Error).message}`);
			continue;
		}
		if (!isObject(record)) {
			problems.push(`${at}: stage.json is not an object`);
			continue;
		}
		if (record.schema === LEGACY_STAGE_SCHEMA) {
			problems.push(`${at}: stage.json is a legacy ${LEGACY_STAGE_SCHEMA} record: refused, a legacy stage is never converted into a native binding`);
			continue;
		}
		if (record.schema !== NATIVE_STAGE_SCHEMA) {
			problems.push(`${at}: stage.json schema ${show(record.schema)} is not ${NATIVE_STAGE_SCHEMA}`);
			continue;
		}
		if (record.client !== j.client) problems.push(`${at}: stage.json is for ${show(record.client)}, not ${j.client}`);
		const up = uploadFacts(record, p, at, j.target?.runtime.compatibilityFlags ?? []);
		problems.push(...up.problems);
		j.upload = up.upload;
		if (j.target && up.upload) {
			const expected = nativeStageRecord(j.target, { files: Object.fromEntries(NATIVE_CLIENT_FILES.map((f) => [f, sha256(f === 'target.json' ? e.files.targetJson : e.files.configJsonc)])), artifact: p.artifact, migrations: p.migrations, upload: up.upload });
			if (e.files.stageJson !== `${JSON.stringify(expected, null, 2)}\n`) problems.push(`${at}: stage.json is not the record of this target, config and the pinned artifact, migrations and entry: a file hash, identity, upload, claim flag or byte layout differs from what the pins and the staged files imply`);
		}
	}

	// 5. Every fact the manifest observed, against the target the stage was built for.
	for (const mc of manifest.clients) {
		const j = judged.find((x) => x.client === mc.client);
		const t = j?.target;
		const p = pins[mc.client]!;
		if (!j || !t) continue;
		const at = mc.client;
		const eq = (what: string, observed: unknown, staged: unknown) => {
			if (observed !== staged) problems.push(`${at}: observed ${what} ${show(observed)} is not the stage's ${show(staged)}`);
		};
		eq('account', manifest.accountId, t.accountId);
		eq('zone id', manifest.zone.id, t.zone.id);
		eq('zone name', manifest.zone.name, t.zone.name);
		eq('Worker', mc.worker, t.worker);
		eq('domain service', mc.domain.service, t.worker);
		eq('custom-domain hostname', mc.domain.hostname, t.customDomain.hostname);
		eq('custom-domain zone', mc.domain.zoneId, t.customDomain.zoneId);
		eq('d1 binding', mc.d1.binding, t.d1.binding);
		eq('d1 name', mc.d1.name, t.d1.name);
		eq('d1 id', mc.d1.id, t.d1.id);
		eq('d1 jurisdiction', mc.d1.jurisdiction, t.d1.jurisdiction);
		eq('r2 binding', mc.r2.binding, t.r2.binding);
		eq('r2 bucket', mc.r2.bucket, t.r2.bucket);
		eq('r2 jurisdiction', mc.r2.jurisdiction, t.r2.jurisdiction);
		if (!sameSet(mc.secretNames, t.secrets)) problems.push(`${at}: observed secret inventory ${show(mc.secretNames)} is not the stage's secret names ${show(t.secrets)}`);
		eq('release source', mc.release.sourceSha, t.runtime.sourceSha);
		eq('release source', mc.release.sourceSha, p.source);
		eq('release artifact', mc.release.artifactSha256, p.artifact);
		eq('release artifact', mc.release.artifactSha256, t.runtime.artifactSha256);
		if (mc.release.profileRevision !== a.profileRevision) problems.push(`${at}: observed profile revision ${mc.release.profileRevision} is not the reviewed profile revision ${a.profileRevision}`);
		if (j.upload) {
			const canary = `${NATIVE_STAGED.assets}${mc.canary.assetPath}`;
			const staged = j.upload.files.find((f) => f.path === canary);
			if (!staged) problems.push(`${at}: the observed asset canary ${mc.canary.assetPath} is not a staged upload file (${canary})`);
			else if (staged.sha256 !== mc.canary.assetSha256) problems.push(`${at}: observed asset canary bytes ${mc.canary.assetSha256} are not the staged ${canary} ${staged.sha256}`);
		}
	}

	// 6. Revalidation: a second read of the same stages, after everything above, must be identical.
	const t1 = reading('revalidation');
	if (typeof t1 === 'string') problems.push(t1);
	else {
		if (t1 < t0) problems.push(`the clock went backwards: ${t1} after ${t0}`);
		const second = pass(2, t1);
		for (const client of names) {
			const a1 = first.get(client);
			const a2 = second.get(client);
			if (!a1 || !a2) {
				if (a1 && !a2) problems.push(`${client}: the evidence could not be revalidated`);
				continue;
			}
			if (content(a1) !== content(a2)) problems.push(`${client}: revalidation read different evidence (the stage changed between the first and the second read)`);
			if (a2.readAt < a1.readAt) problems.push(`${client}: the revalidation read time ${a2.readAt} went backwards from ${a1.readAt}`);
		}
	}
	if (problems.length) return hold(problems);
	const bound = manifest.clients.map((mc): BoundClient => {
		const j = judged.find((x) => x.client === mc.client)!;
		const p = pins[mc.client]!;
		return {
			client: mc.client,
			accountId: manifest.accountId,
			zoneId: manifest.zone.id,
			worker: mc.worker,
			hostname: mc.domain.hostname,
			domainId: mc.domain.id,
			d1Id: mc.d1.id,
			r2Bucket: mc.r2.bucket,
			versionIds: [...mc.versionIds],
			secretNames: [...mc.secretNames],
			sourceSha: mc.release.sourceSha,
			artifactSha256: mc.release.artifactSha256,
			profileRevision: mc.release.profileRevision,
			targetSha256: p.target,
			configSha256: p.config,
			entrySha256: p.entry,
			stageSha256: j.stageSha256,
			readAt: j.evidence.readAt,
		};
	});
	return issue('BOUND-STRUCTURAL', [], bound);
}

/**
 * Problems with `x` as a native binding: it must be a result bindNativeStages issued in this process and be bound. A stored
 * JSON copy, a spread copy, a synthetic receipt label or a hand-built object is structural data that cannot be re-judged
 * here, so it is refused, and no flag in it can ever read as provider proof, control-ready or funded.
 */
export function nativeBindingProblems(x: unknown): string[] {
	if (!isObject(x)) return ['the binding is not an object: only a result issued by bindNativeStages can be judged'];
	if (!ISSUED.has(x)) return ['the binding was not issued by bindNativeStages in this process: a stored JSON record, a copy or a hand-built label is structural data and cannot be re-judged here'];
	if (x.state !== 'BOUND-STRUCTURAL') return [`the binding is HOLD, not bound: ${(Array.isArray(x.problems) ? x.problems : []).join('; ')}`];
	return [];
}
