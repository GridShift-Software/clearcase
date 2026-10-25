// Light structural checks only. The optional real tree is read-only; all mutations are in our scratch directory.
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { nativeArtifactLayout, type NativeTarget } from '../../../../deploy/native-alpha/pipeline.ts';
import { assembleNativeArtifact, checkNativePublicBuild } from '../../../../scripts/hosted-native-bundle/build.ts';

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

// Set explicitly by the receipt; absent is an error, not a skipped acceptance check.
const real = () => {
	if (!process.env.NATIVE_PUBLIC_REAL_TREE) throw new Error('NATIVE_PUBLIC_REAL_TREE must name the read-only complete real build checkout');
	return process.env.NATIVE_PUBLIC_REAL_TREE;
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
