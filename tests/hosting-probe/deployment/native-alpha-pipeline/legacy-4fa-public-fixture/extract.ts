// Extracts the committed LEGACY 4fa042bd public-build regression fixture into a fresh, process-owned temporary directory.
// See README.md here: this is a historical regression input, not current acceptance, deploy or provider proof.
//
// Everything read here is a read-only input. The manifest is pinned by MANIFEST_SHA256 (below); the manifest pins the archive's
// size and SHA-256 and every file's size and SHA-256. Extraction decompresses with an exact output bound, checks each file,
// creates only regular files with flag `wx` under a directory this call created, and never executes or deploys anything.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LEGACY_MANIFEST = path.join(HERE, 'manifest.json');
/** SHA-256 of manifest.json's bytes. Regenerate with build-archive.ts and review the diff when this changes. */
export const MANIFEST_SHA256 = 'sha256:962c5ee9d6ce6e3900862464f66ea7aae219803e94da16f14e872c4e1e90a46a';

/** The three trees of the build checkout the tests read, relative to the extracted root. */
export const LEGACY_TREES = ['.svelte-kit/cloudflare', '.svelte-kit/output/client', '.local/native-nodejs-compat-bundle/bundle'] as const;
export const LEGACY_SCHEMA = 'clearcase-legacy-public-fixture/1';
export const LIMITS = { manifestBytes: 256 * 1024, archiveBytes: 4 * 1024 * 1024, fileBytes: 4 * 1024 * 1024, unpackedBytes: 8 * 1024 * 1024, files: 128 } as const;
const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._%@+-]+$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
export const sha256Of = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

export type LegacyFile = { path: string; bytes: number; sha256: string };
export type LegacyManifest = {
	schema: typeof LEGACY_SCHEMA;
	label: string;
	source: { commit: string; subject: string; builtAt: string; note: string };
	archive: { file: string; format: 'brotli'; bytes: number; sha256: string; unpackedBytes: number };
	goldens: { bundleWorker: string; appEntry: { path: string; sha256: string }; clientAssets: string };
	files: LegacyFile[];
};
export type LegacyFixture = { root: string; manifest: LegacyManifest; cleanup(): void };
export class LegacyFixtureRefusal extends Error {}
const refuse = (why: string): never => { throw new LegacyFixtureRefusal(`legacy 4fa public fixture refused: ${why}`); };

/** A regular, non-symlink file no larger than `max` bytes, read whole. */
function readBounded(file: string, max: number, what: string): Buffer {
	const st = lstatSync(file);
	if (!st.isFile()) refuse(`${what} is not a regular file`);
	if (st.size > max) refuse(`${what} is ${st.size} bytes, over the ${max} byte bound`);
	return readFileSync(file);
}

/** Strict structural check of a parsed manifest; the closed path set is the only inventory the extractor will write. */
export function parseManifest(text: string): LegacyManifest {
	const m = JSON.parse(text) as LegacyManifest;
	const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
	if (!isObj(m) || m.schema !== LEGACY_SCHEMA) refuse('unknown manifest schema');
	if (!isObj(m.archive) || m.archive.format !== 'brotli' || !DIGEST.test(m.archive.sha256) || !Number.isSafeInteger(m.archive.bytes) || m.archive.bytes < 1 || m.archive.bytes > LIMITS.archiveBytes) refuse('malformed archive record');
	if (!Number.isSafeInteger(m.archive.unpackedBytes) || m.archive.unpackedBytes < 1 || m.archive.unpackedBytes > LIMITS.unpackedBytes) refuse('malformed unpacked size');
	if (typeof m.archive.file !== 'string' || !SEGMENT.test(m.archive.file)) refuse('malformed archive file name');
	if (!Array.isArray(m.files) || m.files.length < 1 || m.files.length > LIMITS.files) refuse('malformed file list');
	const seen = new Set<string>(); let total = 0;
	for (const f of m.files) {
		if (!isObj(f) || typeof f.path !== 'string' || !DIGEST.test(f.sha256) || !Number.isSafeInteger(f.bytes) || f.bytes < 0 || f.bytes > LIMITS.fileBytes) refuse('malformed file record');
		const tree = LEGACY_TREES.find(t => f.path.startsWith(`${t}/`));
		if (!tree) refuse(`${f.path} is outside the closed trees`);
		const rest = f.path.slice(tree!.length + 1).split('/');
		if (!rest.every(s => SEGMENT.test(s))) refuse(`${f.path} is not a plain relative path`);
		const key = f.path.toLowerCase();
		if (seen.has(key)) refuse(`${f.path} is listed twice`);
		seen.add(key); total += f.bytes;
	}
	if (total !== m.archive.unpackedBytes) refuse('the listed file sizes do not add up to the unpacked size');
	return m;
}

/** Every regular file below `root`, as POSIX-relative paths; refuses anything else (symlink, device, socket, FIFO). */
function walkFiles(root: string, rel = ''): string[] {
	const out: string[] = [];
	for (const name of readdirSync(path.join(root, rel)).sort()) {
		const r = rel ? `${rel}/${name}` : name;
		const st = lstatSync(path.join(root, r));
		if (st.isDirectory()) out.push(...walkFiles(root, r));
		else if (st.isFile() && st.nlink === 1) out.push(r);
		else refuse(`${r} extracted as something other than a plain file`);
	}
	return out;
}

/**
 * Extracts the fixture into a new directory made with mkdtemp under `parent` (default: the OS temp directory).
 * The returned `cleanup` removes exactly that directory, once; a failed extraction removes it before throwing.
 * `manifestFile`, `archiveFile` and `expectedManifestSha256` exist so the tamper controls can aim the same code at corrupted copies.
 */
export function extractLegacyPublicFixture(opts: { parent?: string; manifestFile?: string; archiveFile?: string; expectedManifestSha256?: string } = {}): LegacyFixture {
	const manifestFile = opts.manifestFile ?? LEGACY_MANIFEST;
	const manifestBytes = readBounded(manifestFile, LIMITS.manifestBytes, 'the manifest');
	if (sha256Of(manifestBytes) !== (opts.expectedManifestSha256 ?? MANIFEST_SHA256)) refuse('the manifest is not the pinned one');
	const manifest = parseManifest(manifestBytes.toString('utf8'));
	const archive = readBounded(opts.archiveFile ?? path.join(path.dirname(manifestFile), manifest.archive.file), manifest.archive.bytes, 'the archive');
	if (archive.length !== manifest.archive.bytes || sha256Of(archive) !== manifest.archive.sha256) refuse('the archive is not the one the manifest pins');
	let unpacked: Buffer;
	try { unpacked = brotliDecompressSync(archive, { maxOutputLength: manifest.archive.unpackedBytes }); } catch { return refuse('the archive does not decompress within its recorded size'); }
	if (unpacked.length !== manifest.archive.unpackedBytes) refuse('the archive unpacks to a different size than recorded');

	const parent = opts.parent ?? os.tmpdir();
	const root = mkdtempSync(path.join(parent, 'native-legacy-4fa-'));
	let cleaned = false;
	const cleanup = () => { if (!cleaned) { cleaned = true; rmSync(root, { recursive: true, force: true }); } };
	try {
		const realRoot = realpathSync(root);
		let at = 0;
		for (const f of manifest.files) {
			const b = unpacked.subarray(at, at += f.bytes);
			if (sha256Of(b) !== f.sha256) refuse(`${f.path} does not match its recorded SHA-256`);
			const dst = path.join(realRoot, ...f.path.split('/'));
			if (path.relative(realRoot, dst).startsWith('..') || path.isAbsolute(path.relative(realRoot, dst))) refuse(`${f.path} escapes the extraction root`);
			mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
			writeFileSync(dst, b, { flag: 'wx', mode: 0o644 });
		}
		const want = manifest.files.map(f => f.path).sort();
		const got = walkFiles(realRoot).sort();
		if (JSON.stringify(got) !== JSON.stringify(want)) refuse('the extracted tree is not exactly the listed inventory');
		return { root: realRoot, manifest, cleanup };
	} catch (e) { cleanup(); throw e; }
}
