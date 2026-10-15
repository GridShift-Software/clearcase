import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_KEY_PATTERN, mediaTypeForName, servePolicy } from '../case-package/browser.ts';
import { contentContradictsType } from '../case-package/media.ts';
import { originalsHost, originalsOrigin } from './config.server.ts';
import { openInside, readAllFd, snapshotVerified, type Opened, type Refusal } from './fsafe.server.ts';
import type { LocalCase } from './service.server.ts';
import type { AssetServeRow } from './store.server.ts';

const RV = 'sha256:[0-9a-f]{64}';
const KEY = ASSET_KEY_PATTERN.slice(1, -1);
const ROUTE = new RegExp(`^/(o|view)/(${RV})/(${KEY})(?:/[^/]*)?$`);
const FRAME_DESTS = new Set(['iframe', 'frame', 'embed', 'object', 'fencedframe']);
const MAX_LARGE_SNAPSHOTS = 2;

const FILE_CSP = "sandbox; default-src 'none'; frame-ancestors 'none'";
const WRAPPER_CSP = "sandbox allow-scripts allow-same-origin allow-downloads; default-src 'none'; script-src 'self'; connect-src 'self'; frame-src 'self'; child-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const BASE_HEADERS: Record<string, string> = {
	'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin', 'cross-origin-opener-policy': 'same-origin',
	'referrer-policy': 'no-referrer', 'cache-control': 'private, no-store',
};
const STATIC_TYPES: Record<string, string> = { mjs: 'text/javascript; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', json: 'application/json', html: 'text/html; charset=utf-8', bcmap: 'application/octet-stream', pfb: 'application/octet-stream', ttf: 'font/ttf', icc: 'application/octet-stream' };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

export class LinkCapability {
	readonly #key: Buffer;
	constructor(dataDir: string) {
		const file = path.join(dataDir, 'link-key');
		mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		let key: Buffer | null = null;
		try { key = readFileSync(file); } catch { /* first start */ }
		if (!key || key.length !== 32) {
			key = randomBytes(32);
			writeFileSync(file, key, { mode: 0o600 });
		}
		chmodSync(file, 0o600);
		this.#key = key;
	}
	token(vid: string, key: string) { return createHmac('sha256', this.#key).update(`${vid}\0${key}`).digest('base64url').slice(0, 32); }
	ok(vid: string, key: string, k: string | null) {
		if (!k || k.length !== 32) return false;
		return timingSafeEqual(Buffer.from(k), Buffer.from(this.token(vid, key)));
	}
}

function findPdfjs(): string | null {
	if (process.env.PDFJS_DIR) return process.env.PDFJS_DIR;
	let d = path.dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 8; i++, d = path.dirname(d)) for (const c of [path.join(d, 'pdfjs'), path.join(d, 'build', 'pdfjs')]) if (existsSync(path.join(c, 'manifest.json'))) return c;
	return null;
}

export type Presentation = 'viewer' | 'inline' | 'text' | 'download';
export type OnDiskRefusal = Refusal | 'case-folder' | 'size';

export class OriginalsServer {
	readonly origin: string;
	readonly host: string;
	readonly links: LinkCapability;
	readonly pdfjsDir: string | null;
	readonly pdfjs: { pdfjsVersion: string; files: Record<string, string> } | null;
	#server: Server | null = null;
	#largeInFlight = 0;

	private readonly app: LocalCase;

	constructor(app: LocalCase) {
		this.app = app;
		// links name the public origin when one is configured (a tunnel in front of this site); the Host check below stays on the site's own host
		this.origin = app.config.originalsPublicOrigin ?? originalsOrigin(app.config);
		this.host = originalsHost(app.config);
		this.links = new LinkCapability(app.config.dataDir);
		this.pdfjsDir = findPdfjs();
		this.pdfjs = this.pdfjsDir ? JSON.parse(readFileSync(path.join(this.pdfjsDir, 'manifest.json'), 'utf8')) : null;
	}

	static presentation(a: Pick<AssetServeRow, 'media_type' | 'real_path' | 'download_only'>): Presentation {
		if (!a.real_path || a.download_only) return 'download';
		const name = a.real_path.slice(a.real_path.lastIndexOf('/') + 1);
		if (mediaTypeForName(name) !== a.media_type) return 'download';
		const { mode } = servePolicy(a.media_type, name, false);
		if (mode === 'download') return 'download';
		if (mode === 'text-sandboxed') return 'text';
		return a.media_type === 'application/pdf' ? 'viewer' : 'inline';
	}

	#opath(vid: string, key: string, name: string) { return `/o/${vid}/${key}/${encodeURIComponent(name)}?k=${this.links.token(vid, key)}`; }
	originalHref(vid: string, key: string, name: string) { return `${this.origin}${this.#opath(vid, key, name)}`; }
	downloadHref(vid: string, key: string, name: string) { return `${this.originalHref(vid, key, name)}&download=1`; }
	viewerHref(vid: string, key: string) { return `${this.origin}/view/${vid}/${key}?k=${this.links.token(vid, key)}`; }

	#viewerHtml(vid: string, key: string, name: string) {
		const raw = `${this.#opath(vid, key, name)}&download=1`;
		const P = `/_pdfjs/${this.pdfjs!.pdfjsVersion}`;
		return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">` +
			`<title>${esc(name)}</title><link rel="stylesheet" href="${P}/viewer.css"><script type="module" src="${P}/wrapper.mjs"></script></head>` +
			`<body class="wrapper" data-src="${esc(raw)}"><header class="bar"><strong id="name">${esc(name)}</strong><span id="wrap-status" role="status">Loading…</span>` +
			`<a id="download" href="${esc(raw)}" download>Download</a></header>` +
			`<iframe id="viewer" title="PDF pages of ${esc(name)}" sandbox="allow-scripts" referrerpolicy="no-referrer" data-frame="${P}/frame.html"></iframe></body></html>`;
	}

	async handle(req: IncomingMessage, res: ServerResponse) {
		const send = (status: number, body: string, headers: Record<string, string | number> = {}) => {
			res.writeHead(status, { ...BASE_HEADERS, 'content-security-policy': FILE_CSP, 'content-type': 'text/plain; charset=utf-8', ...headers });
			res.end(req.method === 'HEAD' ? undefined : body);
		};
		if (req.headers.host !== this.host) return send(421, 'misdirected request: unknown Host');
		if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed', { allow: 'GET, HEAD' });
		if (!this.app.startupReport) return send(503, 'starting', { 'retry-after': 1 });
		if (this.app.storageError) return send(503, 'storage unavailable');
		const url = new URL(req.url ?? '/', this.origin);

		const st = /^\/_pdfjs\/([0-9.]+)\/(.+)$/.exec(url.pathname);
		if (st) {
			let rel: string;
			try { rel = decodeURIComponent(st[2]!); } catch { return send(404, 'not found'); }
			if (!this.pdfjs || st[1] !== this.pdfjs.pdfjsVersion || !Object.hasOwn(this.pdfjs.files, rel)) return send(404, 'not found');
			const body = readFileSync(path.join(this.pdfjsDir!, ...rel.split('/')));
			const O = this.origin;
			// The opaque pdf.js frame loads its bundle with CORS (Origin: null); its CSP spells 'self' out.
			const frameCsp = `sandbox allow-scripts; default-src 'none'; script-src ${O}; connect-src ${O}; img-src ${O} data: blob:; style-src ${O}; font-src ${O} data:; worker-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${O}`;
			res.writeHead(200, { ...BASE_HEADERS, 'cross-origin-resource-policy': 'cross-origin', 'access-control-allow-origin': '*', 'content-security-policy': frameCsp, 'content-type': STATIC_TYPES[rel.split('.').at(-1)!] ?? 'application/octet-stream', 'content-length': body.length });
			return res.end(req.method === 'HEAD' ? undefined : body);
		}

		const m = ROUTE.exec(url.pathname.replace(/%3A/gi, ':'));
		const site = req.headers['sec-fetch-site'];
		if (site !== undefined && site !== 'same-origin' && site !== 'none') {
			const dest = String(req.headers['sec-fetch-dest'] ?? '');
			if (FRAME_DESTS.has(dest) || !m || !this.links.ok(m[2]!, m[3]!, url.searchParams.get('k')))
				return send(403, 'This link to an original is not valid here. Open the original from ClearCase.');
		}
		const a = m ? this.app.store.assetForServe(m[2]!, m[3]!) : undefined;
		if (!m || !a) return send(404, 'unknown original');
		if (!a.real_path || !a.sha256 || a.size === null || (a.status !== 'verified' && a.status !== 'case-mismatch'))
			return send(410, `original not available: ${a.status === 'embedded' ? 'it is inside its parent container; open the parent' : 'missing at import'}`);
		const name = a.real_path.slice(a.real_path.lastIndexOf('/') + 1);
		const mode = OriginalsServer.presentation(a);
		if (m[1] === 'view') {
			if (mode !== 'viewer' || !this.pdfjs) return send(404, 'no viewer for this original; use Download');
			const html = this.#viewerHtml(m[2]!, m[3]!, name);
			res.writeHead(200, { ...BASE_HEADERS, 'content-security-policy': WRAPPER_CSP, 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
			return res.end(req.method === 'HEAD' ? undefined : html);
		}
		return this.#serveOriginal(req, res, a as AssetServeRow & { real_path: string; sha256: string; size: number }, name, mode, url, send);
	}

	static async openChecked(a: AssetServeRow & { real_path: string; size: number }): Promise<{ o: Opened } | { refused: OnDiskRefusal; reason: string }> {
		const root = a.case_root;
		const rst = await stat(root, { bigint: true }).catch(() => null);
		if (!rst || String(rst.dev) !== a.case_dev || String(rst.ino) !== a.case_ino) return { refused: 'case-folder', reason: 'the case folder is missing, or was moved or replaced since import' };
		const o = await openInside(path.join(root, ...a.real_path.split('/')), root);
		if ('refused' in o) return { refused: o.refused, reason: ({ escape: 'outside the case folder', hardlink: 'the file has other hard links', 'not-regular': 'not a regular file', missing: 'missing on disk' } as const)[o.refused] };
		if (o.id.size !== a.size) { await o.fh.close().catch(() => {}); return { refused: 'size', reason: 'changed since import (size differs)' }; }
		return { o };
	}

	static async availability(a: AssetServeRow & { real_path: string; size: number }): Promise<{ refused: OnDiskRefusal; reason: string } | null> {
		const c = await OriginalsServer.openChecked(a);
		if ('refused' in c) return c;
		await c.o.fh.close().catch(() => {});
		return null;
	}

	async #serveOriginal(req: IncomingMessage, res: ServerResponse, a: AssetServeRow & { real_path: string; sha256: string; size: number }, name: string, mode: Presentation, url: URL, send: (s: number, b: string, h?: Record<string, string | number>) => void) {
		const c = await OriginalsServer.openChecked(a);
		if ('refused' in c) return send(410, `original not available: ${c.reason}`);
		const { o } = c;
		let snapshot: string | null = null;
		try {
			const changed = () => send(410, 'original not available: changed since import (its content differs from the sha256 recorded at import)');
			const headers = (head: Uint8Array) => {
				const forceDownload = url.searchParams.get('download') === '1' || mode === 'download' || mode === 'viewer' || contentContradictsType(a.media_type, head);
				const p = servePolicy(a.media_type, name, forceDownload);
				return { ...BASE_HEADERS, ...lower(p.headers), 'cross-origin-resource-policy': 'same-origin', 'content-length': String(a.size) };
			};
			if (a.size <= this.app.config.bufferMaxBytes) {
				const whole = await readAllFd(o);
				if (!whole || createHash('sha256').update(whole).digest('hex') !== a.sha256) return changed();
				res.writeHead(200, headers(whole.subarray(0, 1024)));
				return void res.end(req.method === 'HEAD' ? undefined : whole);
			}
			if (this.#largeInFlight >= MAX_LARGE_SNAPSHOTS) return send(503, 'busy verifying other large originals; try again in a moment', { 'retry-after': 2 });
			this.#largeInFlight++;
			try {
				mkdirSync(this.app.serveTmpDir, { recursive: true, mode: 0o700 });
				snapshot = path.join(this.app.serveTmpDir, `${process.pid}-${randomBytes(8).toString('hex')}`);
				const abort = new AbortController();
				res.once('close', () => abort.abort());
				if (!(await snapshotVerified(o, a.sha256, snapshot, abort.signal))) { snapshot = null; return res.destroyed ? undefined : changed(); }
			} finally { this.#largeInFlight--; }
			// Stream from the verified snapshot through its descriptor; its name is removed first, so nothing is left
			// behind even if the process dies while streaming (startup also clears serve-tmp).
			const fh = await open(snapshot, 'r');
			await rm(snapshot, { force: true });
			snapshot = null;
			try {
				const head = Buffer.alloc(1024);
				await fh.read(head, 0, 1024, 0);
				res.writeHead(200, headers(head));
				if (req.method === 'HEAD') return void res.end();
				await new Promise<void>((resolve) => {
					const s = fh.createReadStream({ start: 0, autoClose: false });
					s.on('error', () => { res.destroy(); resolve(); });
					res.on('close', () => { s.destroy(); resolve(); });
					s.pipe(res);
				});
			} finally { await fh.close().catch(() => {}); }
		} catch (e) {
			if (!res.headersSent) send(500, 'read error'); else res.destroy(e as Error);
		} finally {
			await o.fh.close().catch(() => {});
			if (snapshot) await rm(snapshot, { force: true }).catch(() => {});
		}
	}

	start(): Promise<void> {
		if (!this.pdfjs) console.error('pdf.js bundle not found (build/pdfjs); PDFs will be download-only');
		const server = createServer((req, res) => { this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500, BASE_HEADERS).end(); else res.destroy(); }); });
		this.#server = server;
		return new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(this.app.config.originalsPort, '127.0.0.1', () => {
				server.off('error', reject);
				console.log(`originals site listening on 127.0.0.1:${this.app.config.originalsPort}, addressed as ${this.origin}; pdf.js ${this.pdfjs?.pdfjsVersion ?? 'missing'}`);
				resolve();
			});
		});
	}

	close() {
		this.#server?.close();
		this.#server?.closeAllConnections();
		this.#server = null;
	}
}
