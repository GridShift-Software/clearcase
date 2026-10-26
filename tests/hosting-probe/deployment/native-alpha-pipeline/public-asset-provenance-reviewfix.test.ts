// Light structural checks only. The real build tree is read-only; all mutations are in our scratch directory.
// Unset NATIVE_PUBLIC_REAL_TREE uses the committed LEGACY 4fa042bd public-build fixture (legacy-4fa-public-fixture/README.md).
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { afterAll, afterEach, expect, test } from 'vitest';
import { nativeArtifactLayout, type NativeTarget } from '../../../../deploy/native-alpha/pipeline.ts';
import { assembleNativeArtifact, checkNativePublicBuild } from '../../../../scripts/hosted-native-bundle/build.ts';
import { extractLegacyPublicFixture, LEGACY_MANIFEST, LegacyFixtureRefusal, parseManifest, sha256Of, type LegacyFixture, type LegacyManifest } from './legacy-4fa-public-fixture/extract.ts';

const SHA = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'native-public-')); scratch.push(dir); return dir; };
const worker = `var manifest = (() => { return { app_dir: "_app", app_path: "_app", assets: new Set(["favicon.svg", "fonts/test.woff2", "pdfjs/viewer.mjs"]), client: {start:"_app/start.js",app:"_app/app.js",imports:[],stylesheets:[],fonts:[]} }; })();
var server = create_server(manifest);
export default { fetch(r) { return server.respond(r); } };`;
const publicFiles = () => new Map(Object.entries({
	'favicon.svg': '<svg/>', 'fonts/test.woff2': 'font', 'pdfjs/viewer.mjs': 'export {};',
	'_app/version.json': '{"version":"synthetic"}', '_app/start.js': 'export {};',
	'_app/app.js': 'import "./chunk.js"; const __vite__mapDeps = (i,m=__vite__mapDeps,d=(m.f||(m.f=["./app.css"])))=>i.map(i=>d[i]);',
	'_app/chunk.js': 'export {};', '_app/app.css': '@font-face { src: url("./font.woff2"); }', '_app/font.woff2': '\ufffd binary font',
}).map(([k, v]) => [`artifact/public/${k}`, Buffer.from(v)]));
const layout = (entry: string, bytes: Map<string, Buffer>) => nativeArtifactLayout({
	files: [{ path: 'artifact/cloudflare/_worker.js', bytes: Buffer.byteLength(entry), sha256: SHA(Buffer.from(entry)) }, ...[...bytes].map(([p,b]) => ({path:p, bytes:b.length, sha256:SHA(b)}))],
	entrySha256: SHA(Buffer.from(entry)), headersText: null, entryText: entry, publicFiles: bytes,
} as Parameters<typeof nativeArtifactLayout>[0]);

test('positive manifest and browser dependency closure preserve modules, CSS, fonts, version and static PDF.js', () => {
	const files = publicFiles(); files.set('artifact/public/_app/font.woff2', Buffer.from([0xff,0x00,0xfe]));
	expect(layout(worker, files).problems).toEqual([]);
});
test('final server entry plus a newline has no positive browser/static provenance', () => {
	const files = publicFiles(); files.set('artifact/public/debug.js', Buffer.from(worker + '\n'));
	expect(layout(worker, files).problems.join('\n')).toMatch(/debug.js.*provenance/);
});
test('an arbitrary adapter/server intermediate is not a browser dependency', () => {
	const files = publicFiles(); files.set('artifact/public/debug-server.js', Buffer.from('import {server} from "../cloudflare-tmp/server.js"; export default server;'));
	expect(layout(worker, files).problems.join('\n')).toMatch(/debug-server.js.*provenance/);
});
test('self-certified JSON labels do not grant public provenance', () => {
	const files = publicFiles(); files.set('artifact/public/provenance.json', Buffer.from('{"debug.js":"client"}'));
	expect(layout(worker, files).problems.join('\n')).toMatch(/provenance.json.*provenance/);
});

test('a manifest-shaped decoy not used by the exported Worker grants nothing', () => {
	const files = publicFiles(); files.set('artifact/public/debug.js', Buffer.from('export {};'));
	const decoy = 'var unused = { assets:new Set(["debug.js"]), client:{start:"debug.js"} };';
	expect(layout(worker + decoy, files).problems.join('\n')).toMatch(/debug.js.*provenance/);
});
test('bytes cannot be relabelled by a forged file inventory', () => {
	const files = publicFiles();
	const checked = [...files].map(([p,b]) => ({path:p,bytes:b.length,sha256:SHA(b)}));
	checked.find(f => f.path.endsWith('favicon.svg'))!.sha256 = SHA(Buffer.from('different bytes'));
	expect(nativeArtifactLayout({ files:checked,entrySha256:SHA(Buffer.from(worker)),headersText:null,entryText:worker,publicFiles:files }).problems.join('\n')).toMatch(/not bound to/);
});
test('missing descriptor inputs fail closed rather than falling back to hash inequality', () => {
	expect(nativeArtifactLayout({ files:[],entrySha256:SHA(Buffer.from(worker)),headersText:null }).problems.join('\n')).toMatch(/requires the actual final entry text/);
});
test('a filename under immutable is not by itself browser provenance', () => {
	const files = publicFiles(); files.set('artifact/public/_app/immutable/chunks/debug.js',Buffer.from(worker));
	expect(layout(worker,files).problems.join('\n')).toMatch(/debug.js.*provenance/);
});

// An explicit NATIVE_PUBLIC_REAL_TREE (a receipt's read-only complete build checkout) wins. Unset, the committed legacy 4fa
// fixture is extracted once into a directory this file owns and removed afterwards: never a skip, never a mock. Set but
// empty is an error.
let legacy: LegacyFixture | undefined;
afterAll(() => legacy?.cleanup());
const real = () => {
	const env = process.env.NATIVE_PUBLIC_REAL_TREE;
	if (env === '') throw new Error('NATIVE_PUBLIC_REAL_TREE is set but empty; unset it to use the committed legacy fixture');
	return env ?? (legacy ??= extractLegacyPublicFixture()).root;
};
const target = () => {
	const t = JSON.parse(readFileSync(new URL('./fixtures/clients/client-a/target.json', import.meta.url), 'utf8')) as NativeTarget;
	t.runtime.compatibilityFlags = ['nodejs_als', 'nodejs_compat']; return t;
};
test('the complete real build has positive public provenance, independently of the enum-owner scanner', () => {
	const root = real();
	const r = checkNativePublicBuild({ adapter:path.join(root,'.svelte-kit/cloudflare'), bundle:path.join(root,'.local/native-nodejs-compat-bundle/bundle') });
	expect(r.problems).toEqual([]);
	expect(r.clientAssets).toMatch(/^sha256:[0-9a-f]{64}$/);
});
test('unchanged raw adapter _worker.js copied as debug-server.js is refused', () => {
	const root = real(); const dir = tmp();
	cpSync(path.join(root,'.svelte-kit/cloudflare'), path.join(dir,'cloudflare'), {recursive:true});
	cpSync(path.join(root,'.svelte-kit/output/client'), path.join(dir,'output/client'), {recursive:true});
	writeFileSync(path.join(dir,'cloudflare/debug-server.js'), readFileSync(path.join(root,'.svelte-kit/cloudflare/_worker.js')));
	const r = assembleNativeArtifact({ adapter:path.join(dir,'cloudflare'), bundle:path.join(root,'.local/native-nodejs-compat-bundle/bundle'), out:path.join(dir,'artifact'), target:target() });
	expect(r.problems.join('\n')).toMatch(/debug-server.js.*provenance/);
});
test('the real final server entry plus newline is refused as public/debug.js', () => {
	const root = real(); const dir = tmp();
	cpSync(path.join(root,'.svelte-kit/cloudflare'), path.join(dir,'cloudflare'), {recursive:true});
	cpSync(path.join(root,'.svelte-kit/output/client'), path.join(dir,'output/client'), {recursive:true});
	writeFileSync(path.join(dir,'cloudflare/debug.js'), Buffer.concat([readFileSync(path.join(root,'.local/native-nodejs-compat-bundle/bundle/_worker.js')),Buffer.from('\n')]));
	const r = checkNativePublicBuild({adapter:path.join(dir,'cloudflare'),bundle:path.join(root,'.local/native-nodejs-compat-bundle/bundle')});
	expect(r.problems.join('\n')).toMatch(/debug.js.*provenance/);
});
test('server bytes cannot replace a manifest-referenced browser file even at a legitimate browser path', () => {
	const root = real(); const dir = tmp();
	cpSync(path.join(root,'.svelte-kit/cloudflare'), path.join(dir,'cloudflare'), {recursive:true});
	cpSync(path.join(root,'.svelte-kit/output/client'), path.join(dir,'output/client'), {recursive:true});
	writeFileSync(path.join(dir,'cloudflare/_app/immutable/entry/app.Bmm0BDvz.js'), readFileSync(path.join(root,'.svelte-kit/cloudflare/_worker.js')));
	const r = checkNativePublicBuild({adapter:path.join(dir,'cloudflare'),bundle:path.join(root,'.local/native-nodejs-compat-bundle/bundle')});
	expect(r.problems.join('\n')).toMatch(/app.Bmm0BDvz.js.*no byte-matching provenance/);
});

// The pinned legacy fixture itself. It is a regression input: these tests pin its bytes, not the current build.
const legacyFixture = () => (legacy ??= extractLegacyPublicFixture());
test('the pinned legacy fixture is the recorded 4fa042bd build, byte for byte', () => {
	const { root, manifest: PINNED } = legacyFixture();
	const bundle = path.join(root, '.local/native-nodejs-compat-bundle/bundle');
	expect(PINNED.source.commit).toBe('4fa042bd41e878a70aff08b085ad4b5b4cbccc4e');
	expect(sha256Of(readFileSync(path.join(bundle, '_worker.js')))).toBe(PINNED.goldens.bundleWorker);
	expect(sha256Of(readFileSync(path.join(root, PINNED.goldens.appEntry.path)))).toBe(PINNED.goldens.appEntry.sha256);
	expect(PINNED.goldens.appEntry.path).toMatch(/app\.Bmm0BDvz\.js$/);
	const r = checkNativePublicBuild({ adapter: path.join(root, '.svelte-kit/cloudflare'), bundle });
	expect(r.problems).toEqual([]);
	expect(r.clientAssets).toBe(PINNED.goldens.clientAssets);
});

const pinned = () => legacyFixture().manifest;
// Controls aimed at the extractor: each corrupts a private copy and expects a refusal with nothing left behind.
const owned = () => { const dir = tmp(); return { dir, parent: path.join(dir, 'parent'), copy: path.join(dir, 'copy') }; };
const withCopy = (mutate: (m: LegacyManifest, archive: Buffer) => { manifest?: unknown; archive?: Buffer; pin?: boolean }) => {
	const { parent, copy } = owned(); mkdirSync(parent); mkdirSync(copy);
	const out = mutate(JSON.parse(readFileSync(LEGACY_MANIFEST, 'utf8')), readFileSync(path.join(path.dirname(LEGACY_MANIFEST), pinned().archive.file)));
	const text = `${JSON.stringify(out.manifest ?? pinned())}\n`;
	writeFileSync(path.join(copy, 'manifest.json'), text); writeFileSync(path.join(copy, pinned().archive.file), out.archive ?? readFileSync(path.join(path.dirname(LEGACY_MANIFEST), pinned().archive.file)));
	const run = () => extractLegacyPublicFixture({ parent, manifestFile: path.join(copy, 'manifest.json'), expectedManifestSha256: out.pin === false ? undefined : sha256Of(text) });
	return { run, parent, copy };
};
const refused = (c: { run: () => LegacyFixture; parent: string }, why: RegExp) => {
	expect(c.run).toThrow(LegacyFixtureRefusal); expect(c.run).toThrow(why);
	expect(readdirSync(c.parent)).toEqual([]);
};
test('legacy fixture: a manifest that is not the pinned one is refused before anything is read from it', () => {
	refused(withCopy(m => ({ manifest: { ...m, source: { ...m.source, note: 'edited' } }, pin: false })), /not the pinned one/);
});
test('legacy fixture: one flipped archive byte, a truncated archive and appended bytes are refused', () => {
	for (const edit of [(a: Buffer) => { a[a.length >> 1] ^= 1; return a; }, (a: Buffer) => a.subarray(0, a.length - 1), (a: Buffer) => Buffer.concat([a, Buffer.from([0])])])
		refused(withCopy((_m, a) => ({ archive: edit(Buffer.from(a)) })), /archive/);
});
test('legacy fixture: a file record that disagrees with its bytes is refused even when the manifest pin is consistent', () => {
	refused(withCopy(m => { m.files[3]!.sha256 = sha256Of('other'); return { manifest: m }; }), /does not match its recorded SHA-256/);
});
test('legacy fixture: traversal, absolute, symlink-style, duplicate and outside-tree paths never reach the filesystem', () => {
	for (const bad of ['.svelte-kit/cloudflare/../../escape.js', '/etc/passwd', '.svelte-kit/cloudflare//x.js', '.svelte-kit/cloudflare/a\\b.js', '.svelte-kit/other/x.js', '.local/native-nodejs-compat-bundle/bundle/./x.js'])
		expect(() => parseManifest(JSON.stringify({ ...pinned(), files: [{ ...pinned().files[0]!, path: bad }] }))).toThrow(LegacyFixtureRefusal);
	const [first] = pinned().files as [LegacyManifest['files'][number]];
	const sameName = [first, { ...first, path: `${first.path.slice(0, first.path.lastIndexOf('/') + 1)}${first.path.slice(first.path.lastIndexOf('/') + 1).toUpperCase()}` }];
	expect(() => parseManifest(JSON.stringify({ ...pinned(), files: sameName }))).toThrow(/twice|add up/);
	expect(() => parseManifest(JSON.stringify({ ...pinned(), files: [first, first] }))).toThrow(/twice|add up/);
});
test('legacy fixture: a decompression bomb past its recorded size is refused, not expanded', () => {
	const bomb = brotliCompressSync(Buffer.alloc(8 * 1024 * 1024));
	const file = { path: '.svelte-kit/cloudflare/x.js', bytes: 10, sha256: sha256Of(Buffer.alloc(10)) };
	refused(withCopy(m => ({ archive: bomb, manifest: { ...m, archive: { ...m.archive, bytes: bomb.length, sha256: sha256Of(bomb), unpackedBytes: 10 }, files: [file] } })), /decompress within its recorded size/);
});
test('legacy fixture: a symlinked archive is refused', () => {
	const { parent, copy } = owned(); mkdirSync(parent); mkdirSync(copy);
	const genuine = path.join(path.dirname(LEGACY_MANIFEST), pinned().archive.file);
	symlinkSync(genuine, path.join(copy, pinned().archive.file)); writeFileSync(path.join(copy, 'manifest.json'), readFileSync(LEGACY_MANIFEST));
	expect(() => extractLegacyPublicFixture({ parent, manifestFile: path.join(copy, 'manifest.json') })).toThrow(/archive is not a regular file/);
	expect(readdirSync(parent)).toEqual([]);
});
test('legacy fixture: extraction owns its directory and cleanup removes only that directory, once', () => {
	const { parent } = owned(); mkdirSync(parent);
	const bystander = path.join(parent, 'bystander'); mkdirSync(bystander); writeFileSync(path.join(bystander, 'keep'), 'x');
	const f = extractLegacyPublicFixture({ parent });
	expect(path.dirname(f.root)).toBe(realpathSync(parent));
	expect(f.root).not.toBe(parent);
	expect(existsSync(path.join(f.root, '.svelte-kit/cloudflare/_worker.js'))).toBe(true);
	f.cleanup(); f.cleanup();
	expect(existsSync(f.root)).toBe(false);
	expect(readFileSync(path.join(bystander, 'keep'), 'utf8')).toBe('x');
});
