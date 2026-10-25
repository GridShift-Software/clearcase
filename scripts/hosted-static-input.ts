// Build-time only: give Kit one real static input, before its manifest is captured.
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { prepareHostedPdfAssets, type PdfAssetInventory } from './hosted-pdf-assets.ts';

function directory(path: string): void {
	const parent = dirname(path);
	if (parent !== path) directory(parent);
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`real directory required: ${path}`);
}

function copyStatic(source: string, destination: string): void {
	for (const name of readdirSync(source).sort()) {
		// Never mirror private/hidden material, ambiguous URL paths, or a pre-existing PDF namespace.
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || /^(?:RAWS|secrets?|case|pdfjs)$/i.test(name)) {
			throw new Error(`unsafe static path refused: ${name}`);
		}
		const from = join(source, name), to = join(destination, name), stat = lstatSync(from);
		if (stat.isSymbolicLink()) throw new Error(`static symlink refused: ${from}`);
		if (stat.isDirectory()) {
			mkdirSync(to);
			copyStatic(from, to);
		} else {
			const fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const opened = fstatSync(fd);
				if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error(`single-link regular static file required: ${from}`);
				writeFileSync(to, readFileSync(fd), { flag: 'wx', mode: 0o644 });
			} finally { closeSync(fd); }
		}
	}
}

export type HostedStaticInput = { assets: string; inventory: PdfAssetInventory; dispose(): void };

/** Fixed trusted root/static only; no caller-selected public or output directory.
 * The checkout must be quiescent (as for prepareHostedPdfAssets). Never import this into the Worker.
 * Only the exclusive mkdtemp tree is owned/deleted; root/static and all output directories stay untouched.
 */
export function prepareHostedStaticInput(root: string): HostedStaticInput {
	root = resolve(root);
	directory(root);
	const source = join(root, 'static'), local = join(root, '.local');
	directory(source);
	try { mkdirSync(local, { mode: 0o700 }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
	directory(local);
	const assets = mkdtempSync(join(local, 'hosted-static-input-'));
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		process.removeListener('exit', dispose);
		process.removeListener('SIGINT', interrupt);
		process.removeListener('SIGTERM', terminate);
		rmSync(assets, { recursive: true, force: true });
	};
	const interrupt = () => { dispose(); process.exit(130); };
	const terminate = () => { dispose(); process.exit(143); };
	try {
		copyStatic(source, assets);
		const inventory = prepareHostedPdfAssets({ root, publicRoot: assets });
		process.once('exit', dispose);
		process.once('SIGINT', interrupt);
		process.once('SIGTERM', terminate);
		return { assets, inventory, dispose };
	} catch (error) { dispose(); throw error; }
}
