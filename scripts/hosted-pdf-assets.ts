// Build-time only. No PDF.js code is imported/evaluated and nothing enters the Worker graph.
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOSTED_PDF_VERSION = '6.4.299';
// Path+size+SHA-256 bindings of the 190 installed browser/resource/license files, in ordinal path order.
// Captured from the frozen bun.lock install at c6f0d9536e381dc8eebbf2035f49834409434761.
export const HOSTED_PDF_PACKAGE_DIGEST = 'sha256:ae9a1328f4de3e2cf14b24d711e34299963dc64c10eab7b1afe849b79846e577';
// The in-app viewer's pdf.js worker, pdfjs/pdf-viewer-worker.mjs: build/pdf.worker.min.mjs with WORKER_PATCH applied.
export const HOSTED_PDF_VIEWER_WORKER_DIGEST = 'sha256:79bdd72351096425f4efd42b4c238e7513f321c1a38951a825a148119530b511';

/**
 * The one patch to pdf.js (upstream pdfjs-dist 6.4.299, build/pdf.worker.min.mjs; GRS-251), served only to the in-app
 * viewer as pdfjs/pdf-viewer-worker.mjs. pdfjs/pdf.worker.min.mjs, which the native render check uses, stays upstream,
 * so the package digest and the render check's renderer version do not move. Upstream `BasePdfManager.initDocument`
 * awaits `checkLastPage` before the document opens, and `checkLastPage` reaches the last page through
 * `Catalog.getPageDict`, which fetches every top-level /Kids entry in turn: on a large file that is not linearized, with
 * its page dictionaries spread through the whole file, that is most of the file before page 1 shows. The patch moves the
 * check when /Count is a positive integer: `initDocument` stores it, and the first finished `GetOperatorList` (the
 * worker's part of drawing a page) starts it. When /Count is anything else the document cannot open without the check's
 * recovery, so it still blocks, as upstream. A deferred check still corrects the worker's page count when /Count is
 * wrong, and the added `ClearcasePageCount` request answers, once the check has run, with the corrected count (null when
 * /Count stood), which pdf-reader.mjs passes to the viewer. A deferred check's own failure is no longer a load failure.
 * Each replacement must match exactly once, so another pdf.js build is refused, never half-patched.
 */
const WORKER_PATCH: ReadonlyArray<readonly [string, string]> = [
	['await this.ensureDoc("checkFirstPage",[e]);await this.ensureDoc("checkLastPage",[e])}',
		'await this.ensureDoc("checkFirstPage",[e]);let clearcaseCount;try{clearcaseCount=await this.ensureCatalog("numPages")}catch{}' +
		'if(!(Number.isInteger(clearcaseCount)&&clearcaseCount>0)){await this.ensureDoc("checkLastPage",[e]);return}' +
		'let clearcaseChecked;this.lastPageChecked=new Promise(t=>{clearcaseChecked=t});' +
		'this.deferredLastPageCheck=()=>{this.deferredLastPageCheck=null;this.ensureDoc("checkLastPage",[e]).catch(()=>{}).then(clearcaseChecked)}}'],
	['l){a.getPage(e).then(function(e){const a=new WorkerTask(`GetOperatorList: page ${t}`);',
		'l){const clearcasePdfManager=a;a.getPage(e).then(function(e){const a=new WorkerTask(`GetOperatorList: page ${t}`);'],
	['pageIndex:t,pageProxyId:n}).then(()=>{l.close()},e=>{a.terminated||l.error(e)}).finally(()=>{finishWorkerTask(a)})})});c.on("GetTextContent"',
		'pageIndex:t,pageProxyId:n}).then(()=>{l.close()},e=>{a.terminated||l.error(e)}).finally(()=>{finishWorkerTask(a);clearcasePdfManager.deferredLastPageCheck?.()})})});' +
		'c.on("ClearcasePageCount",async function(){await a.lastPageChecked;const t=a.pdfDocument.catalog;return t.hasActualNumPages?t.numPages:null});c.on("GetTextContent"'],
];
/** The served worker: the upstream bytes with WORKER_PATCH applied, or an error when any replacement is not exactly one match. */
export function patchPdfWorker(upstream: Buffer): Buffer {
	let text = upstream.toString('utf8');
	if (!Buffer.from(text, 'utf8').equals(upstream)) throw new Error('pdf.js worker is not plain UTF-8');
	for (const [from, to] of WORKER_PATCH) {
		if (text.split(from).length !== 2) throw new Error('pdf.js worker patch does not match this build exactly once');
		text = text.replace(from, () => to);
	}
	return Buffer.from(text, 'utf8');
}
/**
 * The in-app viewer's image decoders (GRS-273): pdf.js decodes CCITT fax and JBIG2 through its JBIG2 module and JPX
 * through its OpenJPEG module. The reader runs without wasm (the app's CSP has no 'wasm-unsafe-eval'), so the worker
 * imports these plain-JS builds from pdfjs/wasm/; without them every scanned page draws blank. Their licenses go with
 * them. Bound by their own digest, like the viewer's worker, so the package digest (and the render check's renderer
 * fingerprint, which does not load them) stays where it was. No .wasm file is copied.
 */
const DECODERS = ['jbig2_nowasm_fallback.js', 'openjpeg_nowasm_fallback.js', 'LICENSE_JBIG2', 'LICENSE_OPENJPEG', 'LICENSE_PDFJS_JBIG2', 'LICENSE_PDFJS_OPENJPEG'].map((name) => `wasm/${name}`);
export const HOSTED_PDF_DECODERS_DIGEST = 'sha256:64e5725ef447ad6f8d4b22db596eab1cb45682fbf1f8c631a926c4b7bc7eef41';
export const HOSTED_PDF_READER_DIGEST = 'sha256:e707971d1aea34da5afeb7333eb6b0471447c12c9101167ea9d7f3d5d0e9dbb1';
const READER = 'src/lib/viewer/hosted/static/pdf-reader.mjs';
const hash = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export type PdfAsset = { path: string; bytes: number; sha256: string };
export type PdfAssetInventory = {
	schema: 'clearcase.hosted-pdf-assets/1';
	pdfjsVersion: typeof HOSTED_PDF_VERSION;
	packageDigest: string;
	readerDigest: string;
	files: PdfAsset[];
};

// Check every ancestor too: checking only the final file misses symlinked package/resource/output directories.
function noLinks(path: string): void {
	const absolute = resolve(path);
	const parent = dirname(absolute);
	if (parent !== absolute) noLinks(parent);
	if (lstatSync(absolute).isSymbolicLink()) throw new Error(`symlink refused: ${absolute}`);
}
function directory(path: string): void {
	noLinks(path);
	if (!lstatSync(path).isDirectory()) throw new Error(`directory required: ${path}`);
}
function regular(path: string): Buffer {
	noLinks(path);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		if (!fstatSync(fd).isFile()) throw new Error(`regular file required: ${path}`);
		return readFileSync(fd);
	} finally { closeSync(fd); }
}
const ordinal = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Validate trusted installed inputs, then create publicRoot/pdfjs (must not already exist).
 * publicRoot must already be a real directory. Copies only captured bytes; emits no manifest/public metadata file.
 * This is not a public-provenance waiver: the parent must carry the result through Kit's normal static build input.
 * Run in a quiescent, trusted checkout, not against directories concurrently modified by another process.
 */
export function prepareHostedPdfAssets(a: { root: string; publicRoot: string }): PdfAssetInventory {
	const root = resolve(a.root), publicRoot = resolve(a.publicRoot);
	const pkg = join(root, 'node_modules/pdfjs-dist');
	directory(root); directory(pkg); directory(publicRoot);
	const declared = JSON.parse(regular(join(root, 'package.json')).toString('utf8')) as { devDependencies?: Record<string, unknown> };
	const installed = JSON.parse(regular(join(pkg, 'package.json')).toString('utf8')) as { name?: unknown; version?: unknown };
	if (declared.devDependencies?.['pdfjs-dist'] !== HOSTED_PDF_VERSION || installed.name !== 'pdfjs-dist' || installed.version !== HOSTED_PDF_VERSION) {
		throw new Error(`pdfjs-dist must be declared and installed at exact pin ${HOSTED_PDF_VERSION}`);
	}
	const inputs = new Map<string, Buffer>();
	for (const [source, target] of [['build/pdf.min.mjs', 'pdf.min.mjs'], ['build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'], ['LICENSE', 'LICENSE']]) {
		inputs.set(`pdfjs/${target}`, regular(join(pkg, source!)));
	}
	// These pinned resource directories are flat. Unexpected files, nesting, maps or links fail closed, never get copied.
	for (const dir of ['standard_fonts', 'cmaps', 'iccs']) {
		const source = join(pkg, dir);
		directory(source);
		for (const name of readdirSync(source).sort(ordinal)) inputs.set(`pdfjs/${dir}/${name}`, regular(join(source, name)));
	}
	const list = (files: Map<string, Buffer>): PdfAsset[] => [...files].sort(([a], [b]) => ordinal(a, b)).map(([path, b]) => ({ path, bytes: b.length, sha256: hash(b) }));
	const describe = () => list(inputs);
	if (hash(JSON.stringify(describe())) !== HOSTED_PDF_PACKAGE_DIGEST) throw new Error('installed PDF.js browser/resource/license path+bytes mismatch');
	const decoders = new Map(DECODERS.map((path) => [`pdfjs/${path}`, regular(join(pkg, path))]));
	if (hash(JSON.stringify(list(decoders))) !== HOSTED_PDF_DECODERS_DIGEST) throw new Error('installed PDF.js image decoder path+bytes mismatch');
	const viewerWorker = patchPdfWorker(inputs.get('pdfjs/pdf.worker.min.mjs')!);
	if (hash(viewerWorker) !== HOSTED_PDF_VIEWER_WORKER_DIGEST) throw new Error('patched PDF.js viewer worker bytes mismatch');
	const reader = regular(join(root, READER));
	if (hash(reader) !== HOSTED_PDF_READER_DIGEST) throw new Error('reviewed PDF reader bytes mismatch');
	inputs.set('pdfjs/pdf-reader.mjs', reader);
	inputs.set('pdfjs/pdf-viewer-worker.mjs', viewerWorker);
	for (const [path, bytes] of decoders) inputs.set(path, bytes);
	const inventory: PdfAssetInventory = {
		schema: 'clearcase.hosted-pdf-assets/1', pdfjsVersion: HOSTED_PDF_VERSION,
		packageDigest: HOSTED_PDF_PACKAGE_DIGEST, readerDigest: HOSTED_PDF_READER_DIGEST, files: describe(),
	};
	const out = join(publicRoot, 'pdfjs');
	// Exclusive ownership: never replace a stale tree, follow a link or delete a caller's pre-existing output.
	mkdirSync(out);
	try {
		for (const dir of ['standard_fonts', 'cmaps', 'iccs', 'wasm']) mkdirSync(join(out, dir));
		for (const [path, bytes] of inputs) writeFileSync(join(publicRoot, path), bytes, { flag: 'wx', mode: 0o644 });
	} catch (error) {
		rmSync(out, { recursive: true, force: true });
		throw error;
	}
	return inventory;
}

/** Explicit paths only; no default static-tree writes on import or invocation. */
export function parsePdfAssetArgs(argv: string[]): { root: string; publicRoot: string } | null {
	if (argv.length !== 4) return null;
	const flags = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i]!, value = argv[i + 1]!;
		if (!['--root', '--public-root'].includes(key) || flags.has(key) || !value || value.startsWith('--')) return null;
		flags.set(key, resolve(value));
	}
	return flags.has('--root') && flags.has('--public-root') ? { root: flags.get('--root')!, publicRoot: flags.get('--public-root')! } : null;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = parsePdfAssetArgs(process.argv.slice(2));
	if (!args) {
		console.error('usage: bun scripts/hosted-pdf-assets.ts --root DIR --public-root DIR');
		process.exitCode = 2;
	} else {
		try { console.log(JSON.stringify(prepareHostedPdfAssets(args), null, 2)); }
		catch (error) { console.error(`PDF assets refused: ${(error as Error).message}`); process.exitCode = 1; }
	}
}
