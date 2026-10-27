// Build-time only. No PDF.js code is imported/evaluated and nothing enters the Worker graph.
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOSTED_PDF_VERSION = '6.4.299';
// Path+size+SHA-256 bindings of the 190 installed browser/resource/license files, in ordinal path order.
// Captured from the frozen bun.lock install at c6f0d9536e381dc8eebbf2035f49834409434761.
export const HOSTED_PDF_PACKAGE_DIGEST = 'sha256:ae9a1328f4de3e2cf14b24d711e34299963dc64c10eab7b1afe849b79846e577';
export const HOSTED_PDF_READER_DIGEST = 'sha256:308102fbbc79e94d08645ac61b54f2c39550800eb9a163d3e10d31e340aa861d';
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
	const describe = (): PdfAsset[] => [...inputs].sort(([a], [b]) => ordinal(a, b)).map(([path, b]) => ({ path, bytes: b.length, sha256: hash(b) }));
	if (hash(JSON.stringify(describe())) !== HOSTED_PDF_PACKAGE_DIGEST) throw new Error('installed PDF.js browser/resource/license path+bytes mismatch');
	const reader = regular(join(root, READER));
	if (hash(reader) !== HOSTED_PDF_READER_DIGEST) throw new Error('reviewed PDF reader bytes mismatch');
	inputs.set('pdfjs/pdf-reader.mjs', reader);
	const inventory: PdfAssetInventory = {
		schema: 'clearcase.hosted-pdf-assets/1', pdfjsVersion: HOSTED_PDF_VERSION,
		packageDigest: HOSTED_PDF_PACKAGE_DIGEST, readerDigest: HOSTED_PDF_READER_DIGEST, files: describe(),
	};
	const out = join(publicRoot, 'pdfjs');
	// Exclusive ownership: never replace a stale tree, follow a link or delete a caller's pre-existing output.
	mkdirSync(out);
	try {
		for (const dir of ['standard_fonts', 'cmaps', 'iccs']) mkdirSync(join(out, dir));
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
