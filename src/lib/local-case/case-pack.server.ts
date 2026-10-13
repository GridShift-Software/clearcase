// Import by clicking (GRS-70): the server-side folder browser and the steps that turn a case pack (the .zip as received,
// or the folder it was extracted to) into a case folder and a results package that importPackage then validates.
//  * The browser lists names, kinds and sizes only: folders and .zip files, never file contents.
//  * Nothing is written into a case folder, the ClearCase data directory or the app's checkout. A zip is extracted into
//    a hidden folder beside its target and renamed into place only once every entry is checked; the converted package
//    is written the same way. A later failure or Cancel removes the folders this run created (importCasePack), and a
//    second import of the same pack reuses its extracted folder.
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, stat, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { CASE_ID } from '../case-package/schema.ts';
import { withLimits } from '../case-package/limits.ts';
import { convertV5 } from '../case-package/v5/adapter.ts';
import { writePackageDir } from '../case-package/writer.ts';
import { extractEntries, readCentralDirectory, ZipError, type ZipEntry } from '../case-package/zip.ts';
import { within } from './fsafe.server.ts';

// ---- folder browser ---------------------------------------------------------------------------------------------

export interface FolderEntry { name: string; path: string; kind: 'folder' | 'zip'; size: number | null }
export interface FolderListing {
	path: string;
	parent: string | null;
	crumbs: { name: string; path: string }[];
	shortcuts: { name: string; path: string }[];
	entries: FolderEntry[];
	/** more entries than LIST_MAX: the rest are not listed */
	truncated: boolean;
	error: string | null;
}

const LIST_MAX = 2000;

/** Home, then each Windows drive WSL2 mounts as /mnt/<letter>. */
async function shortcuts(): Promise<{ name: string; path: string }[]> {
	const out = [{ name: 'Home', path: homedir() }];
	const mnt = await readdir('/mnt', { withFileTypes: true }).catch(() => []);
	for (const d of mnt.filter((d) => /^[a-z]$/i.test(d.name)).sort((a, b) => a.name.localeCompare(b.name)))
		if ((await stat(path.join('/mnt', d.name)).catch(() => null))?.isDirectory()) out.push({ name: `Drive ${d.name.toUpperCase()}: (/mnt/${d.name})`, path: path.join('/mnt', d.name) });
	return out;
}

/** One folder's subfolders and .zip files with their sizes. Hidden (dot) entries are left out. Reads no file contents. */
export async function listFolder(requested: string | null): Promise<FolderListing> {
	const dir = path.resolve(requested && path.isAbsolute(requested) ? requested : homedir());
	const parent = path.dirname(dir) === dir ? null : path.dirname(dir);
	const crumbs: { name: string; path: string }[] = [];
	for (let p = dir; ; p = path.dirname(p)) {
		crumbs.unshift({ name: path.basename(p) || p, path: p });
		if (path.dirname(p) === p) break;
	}
	const base = { path: dir, parent, crumbs, shortcuts: await shortcuts(), entries: [] as FolderEntry[], truncated: false };
	let names;
	try { names = await readdir(dir, { withFileTypes: true }); } catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		return { ...base, error: code === 'ENOENT' ? 'This folder does not exist.' : code === 'EACCES' || code === 'EPERM' ? 'ClearCase may not read this folder.' : code === 'ENOTDIR' ? 'This is not a folder.' : `This folder cannot be read (${code ?? 'error'}).` };
	}
	const entries: FolderEntry[] = [];
	for (const d of names) {
		if (d.name.startsWith('.')) continue;
		const isZip = /\.zip$/i.test(d.name);
		if (!d.isDirectory() && !d.isSymbolicLink() && !(d.isFile() && isZip)) continue;
		const p = path.join(dir, d.name);
		const st = await stat(p).catch(() => null); // follows a link: a linked folder is listed as a folder
		if (st?.isDirectory()) entries.push({ name: d.name, path: p, kind: 'folder', size: null });
		else if (st?.isFile() && isZip) entries.push({ name: d.name, path: p, kind: 'zip', size: st.size });
	}
	entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.kind === 'folder' ? -1 : 1));
	return { ...base, entries: entries.slice(0, LIST_MAX), truncated: entries.length > LIST_MAX, error: null };
}

// ---- the steps before importPackage --------------------------------------------------------------------------------

/** A step refused or failed; the message is shown to the user as is. */
export class CasePackError extends Error {}

/** extract: files and bytes; convert: originals fingerprinted; find and write carry no counts */
export interface PackProgress { phase: 'extract' | 'find' | 'convert' | 'write'; done: number; total: number; bytesDone: number; bytesTotal: number }

export interface PrepareOptions {
	signal: AbortSignal;
	onProgress: (p: PackProgress) => void;
	/** ClearCase's own folders: the destination may not lie inside them */
	dataDir: string;
	appDir: string;
	/** the name the app shows for the case; the case folder's name when absent or blank */
	caseLabel?: string;
}

/** A case pack's limits: thousands of files and gigabytes. Free space is checked against the declared total first. */
const PACK_LIMITS = withLimits({ archiveEntries: 1_000_000, archiveEntryBytes: 0xffffffff, archiveTotalBytes: Number.MAX_SAFE_INTEGER, archiveRatio: 1100 });
/** room left beside the extracted case for the results package and the file system's own needs */
const SPACE_MARGIN = 256 * 1024 * 1024;

const isEmptyDir = async (p: string) => (await readdir(p).catch(() => [''])).length === 0;
const exists = (p: string) => stat(p).then(() => true, () => false);
const realOrResolved = (p: string) => realpath(p).catch(() => path.resolve(p));
const step = (phase: PackProgress['phase']): PackProgress => ({ phase, done: 0, total: 0, bytesDone: 0, bytesTotal: 0 });
const gb = (n: number) => `${(n / 1e9).toFixed(2)} GB`;

/** A case id the package schema allows, from a folder name: "CASE Pack v5" -> "case-pack-v5". */
export function caseIdFrom(name: string): string {
	const id = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64).replace(/[^a-z0-9]+$/, '');
	return new RegExp(CASE_ID).test(id) ? id : 'case';
}

/**
 * The workspace HTML in the top of a case folder: the one .html file whose name carries no parenthesised variant
 * ("ESS_DCS_Workspace.html", not "ESS_DCS_Workspace (bundles update only).html"). None or several: refuse, naming them.
 */
export async function findMainHtml(caseFolder: string): Promise<string> {
	const top = await readdir(caseFolder, { withFileTypes: true });
	const html = top.filter((d) => d.isFile() && /\.html?$/i.test(d.name)).map((d) => d.name).sort();
	const main = html.filter((n) => !/\(.*\)/.test(n));
	if (main.length === 1) return path.join(caseFolder, main[0]!);
	if (main.length === 0)
		throw new CasePackError(html.length ? `No main workspace HTML in ${caseFolder}: only variants were found (${html.join(', ')}). Choose the folder that holds the case's workspace HTML.` : `No workspace HTML in ${caseFolder}. Choose the case pack itself, or the folder it was extracted to, which holds the case's workspace .html file.`);
	throw new CasePackError(`More than one workspace HTML in ${caseFolder}: ${main.join(', ')}. ClearCase will not guess which one is the case; keep one of them in the folder, or convert the case in a terminal.`);
}

/** The first of <dest>/<name>-results, -results-2, … that does not exist or is empty. */
async function freeResultsDir(destination: string, name: string): Promise<string> {
	for (let n = 1; ; n++) {
		const p = path.join(destination, `${name}-results${n > 1 ? `-${n}` : ''}`);
		if (!(await exists(p)) || (await isEmptyDir(p))) return p;
	}
}

/** Write into a hidden sibling folder, then rename it to `target` (absent or an empty folder). Any failure removes it. */
async function intoPlace(target: string, fill: (dir: string) => Promise<void>): Promise<void> {
	const partial = path.join(path.dirname(target), `.${path.basename(target)}.clearcase-partial-${randomBytes(4).toString('hex')}`);
	try {
		await fill(partial);
		if (await exists(target)) await rmdir(target); // empty (checked by the caller); rmdir refuses anything else
		await rename(partial, target);
	} catch (e) {
		await rm(partial, { recursive: true, force: true }).catch(() => {});
		throw e;
	}
}

/** <home>/ClearCase: where a case is stored unless the user chooses another folder; created on the first import. */
export const defaultDestination = () => path.join(homedir(), 'ClearCase');

/** The case folder of an extracted pack: the pack's single top folder when every entry sits in one, else the target. */
function caseFolderOf(target: string, entries: readonly ZipEntry[]): string {
	const tops = new Set(entries.map((e) => e.name.split('/')[0]));
	const [only] = tops;
	return tops.size === 1 && entries.every((e) => e.name.includes('/')) ? path.join(target, only!) : target;
}

/** The target holds exactly the pack's files, with the same names and sizes: an earlier extraction of this pack. */
async function holdsExactly(target: string, entries: readonly ZipEntry[]): Promise<boolean> {
	const files = entries.filter((e) => !e.isDirectory);
	const onDisk = (await readdir(target, { recursive: true, withFileTypes: true })).filter((d) => !d.isDirectory());
	if (onDisk.length !== files.length) return false;
	for (const e of files) {
		const st = await lstat(path.join(target, ...e.name.split('/'))).catch(() => null);
		if (!st?.isFile() || st.size !== e.uncompressedSize) return false;
	}
	return true;
}

/**
 * Extract the pack into <destination>/<zip name>, or reuse that folder when an earlier run left exactly the pack's files
 * there (a second import of the same pack). Pushes the folder onto `created` only when this run made it.
 */
async function extractZip(zip: string, destination: string, o: PrepareOptions, created: string[]): Promise<string> {
	const target = path.join(destination, path.basename(zip).replace(/\.zip$/i, ''));
	const fh = await open(zip, 'r');
	try {
		let entries;
		try { entries = await readCentralDirectory(fh, PACK_LIMITS); } catch (e) {
			if (e instanceof ZipError) throw new CasePackError(`The case pack ${path.basename(zip)} cannot be extracted: ${e.message}${e.entry ? ` (${e.entry})` : ''}. Nothing was written. Extract it yourself and choose the extracted folder with Add documents.`);
			throw e;
		}
		const caseFolder = caseFolderOf(target, entries);
		const existed = await exists(target);
		if (existed && !(await isEmptyDir(target))) {
			if (await holdsExactly(target, entries)) return caseFolder;
			throw new CasePackError(`${target} already exists and holds other files than this pack, so the pack is not extracted over it. To import that copy, choose Add documents, open ${caseFolder} and choose Use this folder; otherwise store the case in another folder.`);
		}
		const total = entries.reduce((n, e) => n + e.uncompressedSize, 0);
		const fs = await statfs(destination);
		const free = Number(fs.bavail) * Number(fs.bsize);
		if (free < total + SPACE_MARGIN) throw new CasePackError(`Not enough free space in ${destination}: the case pack needs ${gb(total + SPACE_MARGIN)} and ${gb(free)} is free. Choose another destination.`);
		try {
			await intoPlace(target, (dir) => extractEntries(fh, entries, dir, { signal: o.signal, onProgress: (p) => o.onProgress({ phase: 'extract', ...p }) }));
		} catch (e) {
			if (e instanceof ZipError) throw new CasePackError(`The case pack ${path.basename(zip)} cannot be extracted: ${e.message}${e.entry ? ` (${e.entry})` : ''}. Nothing was kept.`);
			throw e;
		}
		if (!existed) created.push(target);
		return caseFolder;
	} finally {
		await fh.close();
	}
}

/**
 * Extract (a .zip), find the workspace HTML, convert it into <destination>/<case folder name>-results. Returns the case
 * folder and the package folder for importPackage. Throws CasePackError with a message for the user. Each folder this
 * run creates (the extracted pack, the results package) is pushed onto `created`, for the caller to remove on a failure.
 */
export async function prepareCasePack(source: string, destination: string, o: PrepareOptions, created: string[] = []): Promise<{ caseFolder: string; packageDir: string }> {
	if (!path.isAbsolute(source) || !path.isAbsolute(destination)) throw new CasePackError('Choose the case and the destination with the folder browser.');
	const sst = await stat(source).catch(() => null);
	const isZip = !!sst?.isFile() && /\.zip$/i.test(source);
	if (!sst || !(sst.isDirectory() || isZip)) throw new CasePackError(`${source} is neither a folder nor a .zip file.`);
	if (destination === defaultDestination()) await mkdir(destination, { recursive: true }).catch(() => {});
	if (!(await stat(destination).catch(() => null))?.isDirectory()) throw new CasePackError(`The destination ${destination} is not a folder.`);
	if (!(await access(destination, constants.W_OK).then(() => true, () => false))) throw new CasePackError(`ClearCase may not write to ${destination}. Store the case in a folder you can write to.`);
	const dest = await realpath(destination);
	for (const [own, what] of [[await realOrResolved(o.dataDir), 'the ClearCase data directory'], [await realOrResolved(o.appDir), "ClearCase's own program folder"]] as const)
		if (within(dest, own)) throw new CasePackError(`The destination lies inside ${what} (${own}). Choose a folder outside it.`);
	if (!isZip && within(dest, await realpath(source))) throw new CasePackError('The destination lies inside the case folder, and ClearCase never writes into a case folder. Choose a folder outside it.');

	const caseFolder = isZip ? await extractZip(source, dest, o, created) : await realpath(source);
	o.signal.throwIfAborted();
	o.onProgress(step('find'));
	const html = await findMainHtml(caseFolder);
	const name = path.basename(caseFolder);
	const bytes = await readFile(html);
	o.onProgress(step('convert'));
	const conv = await convertV5({ html: bytes, htmlName: path.basename(html), caseFolder, caseId: caseIdFrom(name), caseLabel: o.caseLabel?.trim() || name, signal: o.signal, onProgress: (done, total) => o.onProgress({ ...step('convert'), done, total }) });
	o.signal.throwIfAborted();
	if (!conv.files) {
		const errs = conv.diagnostics.filter((d) => d.severity === 'error');
		throw new CasePackError(`${path.basename(html)} could not be converted: ${errs.slice(0, 5).map((d) => `${d.code} ${d.message}`).join('; ')}${errs.length > 5 ? `; and ${errs.length - 5} more` : ''}. Nothing was imported.`);
	}
	o.onProgress(step('write'));
	const packageDir = await freeResultsDir(dest, name);
	const existed = await exists(packageDir);
	await intoPlace(packageDir, (dir) => writePackageDir(dir, conv.files!));
	if (!existed) created.push(packageDir);
	return { caseFolder, packageDir };
}
