// Regenerates manifest.json and the archive from a complete, read-only 4fa042bd build checkout. Not run by any test.
//
//   bun build-archive.ts --source DIR --out DIR
//
// DIR/.svelte-kit/cloudflare, DIR/.svelte-kit/output/client and DIR/.local/native-nodejs-compat-bundle/bundle are only read.
// The generator refuses a tree the public-build checker does not accept, writes the two files into the empty --out directory,
// and prints the manifest SHA-256 to paste into extract.ts as MANIFEST_SHA256.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import { checkNativePublicBuild } from '../../../../../scripts/hosted-native-bundle/build.ts';
import { LEGACY_SCHEMA, LEGACY_TREES, LIMITS, parseManifest, sha256Of, type LegacyFile, type LegacyManifest } from './extract.ts';

const SOURCE = { commit: '4fa042bd41e878a70aff08b085ad4b5b4cbccc4e', subject: 'Native bundle closure via proven dynamic host imports; separated public assets (NATIVE24)', builtAt: '2026-10-25T07:04:05.533Z' };
const ARCHIVE = 'legacy-4fa-public-build.br';
const APP_ENTRY = '.svelte-kit/cloudflare/_app/immutable/entry/app.Bmm0BDvz.js';
const WORKER = '.local/native-nodejs-compat-bundle/bundle/_worker.js';

function files(root: string, rel = ''): string[] {
	const out: string[] = [];
	for (const name of readdirSync(path.join(root, rel)).sort()) {
		const r = rel ? `${rel}/${name}` : name, st = lstatSync(path.join(root, r));
		if (st.isDirectory()) out.push(...files(root, r));
		else if (st.isFile() && st.nlink === 1) out.push(r);
		else throw new Error(`${r} is not a plain file`);
	}
	return out;
}

const arg = (k: string) => { const i = process.argv.indexOf(k); const v = i > 0 ? process.argv[i + 1] : undefined; if (!v) throw new Error('usage: build-archive.ts --source DIR --out DIR'); return path.resolve(v); };
const source = arg('--source'), out = arg('--out');
if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} is not empty`);

const checked = checkNativePublicBuild({ adapter: path.join(source, LEGACY_TREES[0]), bundle: path.join(source, LEGACY_TREES[2]) });
if (checked.problems.length || !checked.clientAssets) throw new Error(`the source tree is not a clean public build: ${checked.problems.join('; ')}`);

const bytes = new Map<string, Buffer>();
for (const tree of LEGACY_TREES) for (const rel of files(path.join(source, tree))) bytes.set(`${tree}/${rel}`, readFileSync(path.join(source, tree, rel)));
// Sorted order: the archive is exactly the concatenation the manifest lists.
const list: LegacyFile[] = [...bytes.keys()].sort().map(p => ({ path: p, bytes: bytes.get(p)!.length, sha256: sha256Of(bytes.get(p)!) }));
const packed = Buffer.concat(list.map(f => bytes.get(f.path)!));
const archive = brotliCompressSync(packed, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: packed.length } });
const find = (p: string) => list.find(f => f.path === p)!.sha256;
const manifest: LegacyManifest = {
	schema: LEGACY_SCHEMA,
	label: 'LEGACY REGRESSION FIXTURE: a historical 4fa042bd build, pinned so the public-provenance tests run in a clean clone. Not current acceptance, module, deploy or provider proof.',
	source: { ...SOURCE, note: 'Copied unchanged from a complete read-only build checkout; adapter-cloudflare output, Kit output/client and the Wrangler dry-run bundle (including its source map, whose presence the closed bundle inventory requires).' },
	archive: { file: ARCHIVE, format: 'brotli', bytes: archive.length, sha256: sha256Of(archive), unpackedBytes: packed.length },
	goldens: { bundleWorker: find(WORKER), appEntry: { path: APP_ENTRY, sha256: find(APP_ENTRY) }, clientAssets: checked.clientAssets },
	files: list,
};
const text = `${JSON.stringify(manifest, null, '\t')}\n`;
parseManifest(text);
if (archive.length > LIMITS.archiveBytes) throw new Error(`archive is ${archive.length} bytes, over the ${LIMITS.archiveBytes} bound`);
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, ARCHIVE), archive, { flag: 'wx' });
writeFileSync(path.join(out, 'manifest.json'), text, { flag: 'wx' });
console.log(`files=${list.length} unpacked=${packed.length} archive=${archive.length}\nMANIFEST_SHA256 = ${sha256Of(text)}`);
