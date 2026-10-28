import puppeteer, { type Browser, type BrowserWorker, type HTTPRequest, type Page } from '@cloudflare/puppeteer';
import { packageVersion as sdkVersion } from '@cloudflare/puppeteer/lib/esm/puppeteer/generated/version.js';
import { NATIVE_RENDER_SDK_POLICY } from '../../../../scripts/native-render-sdk-policy.ts';
import { NATIVE_SDK_POLICY_IDENTITY } from './sdk-build-contract.ts';
import type { ClientId } from '../../server/runtime/contracts.ts';
import type { CloudD1 } from '../../storage/cloud/bindings.ts';
import type { PreviewFirstViolation, PreviewGotoError, PreviewGotoState, PreviewNavigationObservation, PreviewRenderStage } from '../../publication/hosted/preview-outcome.ts';
import type { NativePdfEvidenceBudget, NativePdfEvidenceChecker, NativePreviewRenderBudget, NativePreviewRenderChecker, PdfEvidenceOutcome, PdfEvidenceStep } from './render-check-contract.ts';
import type { RequiredPreviewState } from '../../publication/hosted/ports.ts';
import type { PreviewReasonCode } from '../../publication/hosted/preview-outcome.ts';
import { checkedPageSet, decide, lookupReceiptRows, MAX_CHECKED_PAGES, MAX_DOCUMENT_PAGES, MAX_RECEIPT_ROW_BYTES, receiptJson, sealReceipt, validPages, type ContentReceipt } from './pdf-content-receipts.ts';

// Deliberately not an import of the build-time (node:fs) asset preparer. Parent supplies its reviewed inventory.
const PDF_VERSION = '6.4.299';
const PACKAGE_DIGEST = 'sha256:ae9a1328f4de3e2cf14b24d711e34299963dc64c10eab7b1afe849b79846e577';
const VIEWER_WORKER_DIGEST = 'sha256:c14b50d04c16081a41c1756232923c0087bcb3113de3540ada92d6d774fd6115';
const READER_DIGEST = 'sha256:782e60af7b31feb6d7e58677e54bdbde307afb7da6dc197ac03ec0f3d8522b63';
export const NATIVE_PDF_RENDERER_ALGORITHM = 'clearcase.native-pdf/2';
const SDK_INTEGRITY = 'sha512-39lo96Y7ErOJFmu/KIJU1VLaOibhynx/BauKCZOW5+RVH/mG0jZrAEGJlqCdx5ZxLHyWppm78YX3jLNPCBB+fA==';
export const NATIVE_PDF_RENDER_CEILINGS: Readonly<NativePreviewRenderBudget> = Object.freeze({
 maxFileBytes: 4_000_000, maxPages: 8, maxCanvasPixels: 4_000_000, maxRunMs: 20_000,
 maxRunsPerCasePerDay: 3, maxRunsPerClientPerDay: 4,
});
// A case limit of 3 needs migrations/0002_preview_render_case_limit.sql; the 0001 schema refuses it at admission.
// No keepalive extension, browser pooling/reuse, automatic retry or account API. Immutable success receipts ARE reused.
// Charge the default idle tail even on success.
const IDLE_TAIL_MS = 60_000, CLEANUP_MS = 2_000, DAY_MS = 86_400_000;
const ROOT = '/__clearcase_native_pdf__/', DOCUMENT = `${ROOT}inspect`, SCRIPT = `${ROOT}inspector.mjs`, PDF = `${ROOT}input.pdf`;
const PDF_PART_PREFIX = `${ROOT}input/`, PDF_PART = /^\/__clearcase_native_pdf__\/input\/(?:0|[1-9][0-9]{0,5})$/;
const MAX_STATIC_BYTES = 8_000_000, MAX_REQUESTS = 220;
/** A refusal that carries only its fixed class, so no message, URL or session text can ride along. */
class Refused extends Error {
 readonly kind: PreviewFirstViolation;
 constructor(kind: PreviewFirstViolation) { super('refused'); this.kind = kind; }
}
function refuse(kind: PreviewFirstViolation): never { throw new Refused(kind); }
const NET_ERRORS: ReadonlyMap<string, PreviewGotoError> = new Map([
 ['ERR_BLOCKED_BY_CLIENT', 'blocked-by-client'], ['ERR_BLOCKED_BY_ADMINISTRATOR', 'blocked-by-administrator'], ['ERR_ACCESS_DENIED', 'access-denied'],
 ['ERR_ABORTED', 'aborted'], ['ERR_FAILED', 'failed'], ['ERR_CONNECTION_REFUSED', 'connection-refused'], ['ERR_CONNECTION_CLOSED', 'connection-closed'],
 ['ERR_CONNECTION_RESET', 'connection-reset'], ['ERR_NAME_NOT_RESOLVED', 'name-not-resolved'], ['ERR_TIMED_OUT', 'timed-out'],
]);
/** Only a token from the closed table leaves; the rejected value, its message and any URL in it are dropped. */
function gotoErrorToken(error: unknown): PreviewGotoError {
 try {
  const code = error instanceof Error && typeof error.message === 'string' ? /\bnet::(ERR_[A-Z0-9_]{1,64})(?![A-Z0-9_])/.exec(error.message)?.[1] : undefined;
  return (code && NET_ERRORS.get(code)) || 'generic';
 } catch { return 'generic'; }
}
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(v => v.toString(16).padStart(2, '0')).join('');
const sha = async (b: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', new Uint8Array(b)));
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const integer = (v: unknown, max: number): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= max;
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

export interface NativePreviewRenderPins {
 schema: 'clearcase.hosted-pdf-assets/1';
 pdfjsVersion: string;
 packageDigest: string;
 readerDigest: string;
 files: readonly Readonly<{ path: string; bytes: number; sha256: string }>[];
}
export interface NativePreviewRenderOptions {
 /** Raw binding, not a read-replica session. Each reservation starts on the primary. */
 db: { withSession(constraint: 'first-primary'): CloudD1 } | null;
 clientId: ClientId;
 browser: BrowserWorker | null;
 assets: { fetch(request: Request): Promise<Response> } | null;
 appOrigin: string;
 pins: NativePreviewRenderPins | null;
 budget: NativePreviewRenderBudget | null;
 now(): Date;
}

// Names the REQUIRED parent SDK build policy, not an attestation that a bundler applied it.
const HTML = '<!doctype html><meta charset="utf-8"><meta name="clearcase-sdk-policy" content="' + NATIVE_RENDER_SDK_POLICY + '"><title>Private PDF inspection</title><script type="module" src="' + SCRIPT + '"></script>';
const CSP = "default-src 'none'; script-src 'self'; worker-src blob:; connect-src 'self'; font-src blob:; img-src blob: data:; style-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// SOURCE-OWNED BROWSER PROGRAM. No caller HTML, strings-as-code, annotations DOM, PDF scripting or eval.
// A real module Worker runs the exact pinned pdf.worker.min.mjs bytes inside a blob; useWorkerFetch:false keeps
// font/cmap/resource reads on the intercepted page. Provider guardrails deny every actual outbound HTTP(S) request.
const INSPECTOR = String.raw`
import * as pdfjs from '/pdfjs/pdf.min.mjs';
let warnings = 0;
for (const name of ['log', 'warn', 'error', 'info', 'debug']) console[name] = () => { warnings++; };
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
window.clearcaseNativePdfInspect = async function (a) {
 let worker, workerUrl, loading, rendering, expired = false;
 const started = performance.now();
 const check = () => { if (expired || performance.now() - started >= a.maxRunMs || warnings) throw Error('inspection refused'); };
 const work = async () => {
  if (pdfjs.version !== '6.4.299') throw Error('renderer mismatch');
  const input = new Uint8Array(await (await fetch('/__clearcase_native_pdf__/input.pdf', { credentials: 'omit', cache: 'no-store', redirect: 'error' })).arrayBuffer());
  if (input.length !== a.size || await digest(input) !== a.sha256) throw Error('input mismatch');
  check();
  const workerBytes = new Uint8Array(await (await fetch('/pdfjs/pdf.worker.min.mjs', { credentials: 'omit', cache: 'no-store', redirect: 'error' })).arrayBuffer());
  if (workerBytes.length !== a.workerBytes || await digest(workerBytes) !== a.workerSha256) throw Error('worker mismatch');
  // PDF.js reports recoveries/unsupported operations via console. Treat them as failure without copying text.
  const prelude = "for (const n of ['log','warn','error','info','debug']) console[n] = () => postMessage({ clearcaseNativeWarning: true });\n";
  workerUrl = URL.createObjectURL(new Blob([prelude, workerBytes], { type: 'text/javascript' }));
  worker = new Worker(workerUrl, { type: 'module' });
  worker.addEventListener('message', e => { if (e.data?.clearcaseNativeWarning === true) warnings++; });
  worker.addEventListener('error', () => { warnings++; });
  pdfjs.GlobalWorkerOptions.workerPort = worker;
  loading = pdfjs.getDocument({
   data: input, isEvalSupported: false, enableXfa: false, enableScripting: false, useWasm: false,
   useWorkerFetch: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: true, verbosity: 1, maxImageSize: a.maxCanvasPixels,
   canvasMaxAreaInBytes: a.maxCanvasPixels * 4, disableAutoFetch: true,
   standardFontDataUrl: location.origin + '/pdfjs/standard_fonts/', cMapUrl: location.origin + '/pdfjs/cmaps/',
   cMapPacked: true, iccUrl: location.origin + '/pdfjs/iccs/',
  });
  const doc = await loading.promise;
  check();
  // enableXfa:false deliberately suppresses isPureXfa; document metadata does not depend on XFA generation.
  const metadata = await doc.getMetadata();
  check();
  if (metadata?.info?.IsXFAPresent !== false || !Number.isInteger(doc.numPages) || doc.numPages < 1 || doc.numPages > a.maxPages || doc.isPureXfa || await doc.getJSActions()) throw Error('unsupported PDF');
  const pages = [];
  let pixels = 0;
  for (let n = 1; n <= doc.numPages; n++) {
   check();
   const page = await doc.getPage(n);
   if (await page.getJSActions()) throw Error('unsupported PDF');
   const viewport = page.getViewport({ scale: 1 });
   const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
   if (![width, height].every(v => Number.isSafeInteger(v) && v > 0 && v <= 4096)) throw Error('canvas limit');
   pixels += width * height;
   if (pixels > a.maxCanvasPixels) throw Error('canvas limit');
   const canvas = document.createElement('canvas');
   canvas.width = width; canvas.height = height;
   const context = canvas.getContext('2d', { willReadFrequently: true });
   if (!context) throw Error('no canvas');
   // No text/annotation layer or document-provided markup. Annotations with appearances are canvas-painted by PDF.js.
   rendering = page.render({ canvas, canvasContext: context, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE, background: 'rgb(255,255,255)' });
   await rendering.promise;
   rendering = null;
   check();
   const readback = context.getImageData(0, 0, width, height).data;
   if (readback.byteLength !== width * height * 4) throw Error('readback incomplete');
   pages.push({ number: n, width, height, pixelBytes: readback.byteLength, pixelSha256: await digest(readback) });
   canvas.width = 0; canvas.height = 0; page.cleanup();
  }
  check();
  return { binding: a.binding, sha256: a.sha256, size: a.size, pdfjsVersion: pdfjs.version, totalPages: doc.numPages, pages };
 };
 let timer;
 try {
  return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { expired = true; rendering?.cancel(); reject(Error('inspection timeout')); }, a.maxRunMs); })]);
 } finally {
  expired = true; clearTimeout(timer); rendering?.cancel();
  // Never wait indefinitely for a damaged document's destroy protocol; the isolated Worker is terminated regardless.
  if (loading) void loading.destroy().catch(() => {});
  worker?.terminate(); if (workerUrl) URL.revokeObjectURL(workerUrl);
 }
};
`;

type RenderInput = Parameters<NativePreviewRenderChecker['verify']>[0];
type RenderResult = Awaited<ReturnType<NativePreviewRenderChecker['verify']>>;
function renderResult(rendererVersion: string, state: RenderResult['state'], reason: string | null, pages: number | null = null, stage?: PreviewRenderStage): RenderResult {
 return stage ? { state, rendererVersion, pages, reason, stage } : { state, rendererVersion, pages, reason };
}
interface PageProof { number: number; width: number; height: number; pixelBytes: number; pixelSha256: string }
interface RenderTranscript { binding: string; sha256: string; size: number; pdfjsVersion: string; totalPages: number; pages: PageProof[] }
type RenderDatabase = NonNullable<NativePreviewRenderOptions['db']>;
type ReceiptScope = { fixed: RenderInput; binding: string; budget: NativePreviewRenderBudget; rendererVersion: string };
const RECEIPT_SELECT = 'SELECT * FROM npr_success_receipts WHERE binding_sha256=?';

/** Read and validate the immutable exact-file fact, NOT candidate generation, grant, sign-off or publication authority. */
async function receiptTranscript(row: unknown, a: ReceiptScope): Promise<RenderTranscript | null> {
 if (!row || typeof row !== 'object') return null;
 const r = row as Record<string, unknown>, f = a.fixed;
 if (r.binding_sha256 !== a.binding || r.client_id !== f.clientId || r.case_id !== f.caseId || r.candidate_id !== f.candidateId ||
     r.results_version !== f.resultsVersion || r.asset_id !== f.assetId || r.input_sha256 !== f.sha256 || r.input_size !== f.bytes.length ||
     r.renderer_version !== a.rendererVersion || !identifier(r.reservation_token) || !Number.isSafeInteger(r.completed_ms) || Number(r.completed_ms) < 0 ||
     typeof r.transcript_json !== 'string' || r.transcript_json.length > 8192 || !hash(r.transcript_sha256)) return null;
 try {
  if (await sha(new TextEncoder().encode(r.transcript_json)) !== r.transcript_sha256) return null;
  const transcript = validateTranscript(JSON.parse(r.transcript_json), a);
  return transcript && r.pages === transcript.totalPages && r.canvas_pixels === transcript.pages.reduce((sum, p) => sum + p.width * p.height, 0) ? transcript : null;
 } catch { return null; }
}

async function readReceipt(db: RenderDatabase, a: ReceiptScope): Promise<{ found: boolean; transcript: RenderTranscript | null }> {
 const row = await db.withSession('first-primary').prepare(RECEIPT_SELECT).bind(a.binding).first<unknown>();
 return { found: row !== null, transcript: row === null ? null : await receiptTranscript(row, a) };
}

/** Commit the genuinely completed transcript and verify its primary transaction readback before returning rendered. */
async function saveReceipt(db: RenderDatabase, a: ReceiptScope, token: string, completed: number, transcript: RenderTranscript): Promise<boolean> {
 const json = JSON.stringify(transcript), digest = await sha(new TextEncoder().encode(json));
 const primary = db.withSession('first-primary');
 const written = await primary.batch([
  primary.prepare(`INSERT INTO npr_success_receipts
   (binding_sha256,reservation_token,client_id,case_id,candidate_id,results_version,asset_id,input_sha256,input_size,renderer_version,completed_ms,pages,canvas_pixels,transcript_json,transcript_sha256)
   SELECT binding_sha256,token,client_id,case_id,candidate_id,results_version,asset_id,input_sha256,input_size,renderer_version,?,?,?,?,?
   FROM npr_reservations WHERE token=? AND binding_sha256=?
   ON CONFLICT(binding_sha256) DO NOTHING`).bind(completed, transcript.totalPages, transcript.pages.reduce((sum, p) => sum + p.width * p.height, 0), json, digest, token, a.binding),
  primary.prepare(RECEIPT_SELECT).bind(a.binding),
 ]);
 const acknowledgements = written as { success?: unknown; results?: unknown[] }[];
 if (acknowledgements.length !== 2 || acknowledgements.some(ack => ack?.success !== true)) return false;
 const rows = acknowledgements[1]?.results;
 if (!rows || rows.length !== 1) return false;
 const readback = await receiptTranscript(rows[0], a);
 return readback !== null && JSON.stringify(readback) === json;
}

type RendererBindings = Pick<NativePreviewRenderOptions, 'db' | 'clientId' | 'browser' | 'assets' | 'appOrigin' | 'pins' | 'now'>;
type PreparedRenderer = {
 db: RenderDatabase; browserBinding: BrowserWorker; assets: AssetsFetcher; clientId: ClientId; now(): Date; origin: string; files: PinnedFiles;
 /** The renderer version of one source-owned program under these pins. */
 fingerprint(algorithm: string, program: string): Promise<string>;
};
/** Bindings, origin and reviewed pins every renderer needs; null when any is missing or not the reviewed one. */
async function prepareRenderer(o: RendererBindings): Promise<PreparedRenderer | null> {
 if (!o.db || typeof o.db.withSession !== 'function' || !o.browser || typeof o.browser.fetch !== 'function' ||
     !o.assets || typeof o.assets.fetch !== 'function' || !identifier(o.clientId) || typeof o.now !== 'function' || !o.pins) return null;
 let origin: string;
 try {
  const url = new URL(o.appOrigin);
  if (url.protocol !== 'https:' || url.origin !== o.appOrigin || url.username || url.password) return null;
  origin = url.origin;
 } catch { return null; }
 // Captured before the first await: the options object is not an immutable authority.
 const pins = o.pins, bound = { db: o.db, browserBinding: o.browser, assets: o.assets, clientId: o.clientId, now: o.now };
 if (pins.schema !== 'clearcase.hosted-pdf-assets/1' || pins.pdfjsVersion !== PDF_VERSION ||
     pins.packageDigest !== PACKAGE_DIGEST || pins.readerDigest !== READER_DIGEST || !Array.isArray(pins.files) || pins.files.length !== 192) return null;
 const files: PinnedFiles = new Map();
 for (const f of pins.files) {
  if (!f || typeof f.path !== 'string' || !/^pdfjs\/(?:pdf(?:\.worker)?\.min\.mjs|pdf-reader\.mjs|pdf-viewer-worker\.mjs|LICENSE|(?:cmaps|iccs|standard_fonts)\/[A-Za-z0-9_.-]+)$/.test(f.path) ||
      files.has('/' + f.path) || !integer(f.bytes, MAX_STATIC_BYTES) || !/^sha256:[a-f0-9]{64}$/.test(f.sha256)) return null;
  files.set('/' + f.path, { path: f.path, bytes: f.bytes, sha256: f.sha256 });
 }
 // The reader and the viewer's patched worker (scripts/hosted-pdf-assets.ts, WORKER_PATCH) are the in-app viewer's, not the package's.
 const packageFiles = [...files.values()].filter(f => f.path !== 'pdfjs/pdf-reader.mjs' && f.path !== 'pdfjs/pdf-viewer-worker.mjs').sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
 if ('sha256:' + await sha(encode(packageFiles)) !== PACKAGE_DIGEST || files.get('/pdfjs/pdf-reader.mjs')?.sha256 !== READER_DIGEST ||
     files.get('/pdfjs/pdf-viewer-worker.mjs')?.sha256 !== VIEWER_WORKER_DIGEST) return null;
 if (sdkVersion !== '1.4.0') return null;
 // NATIVE_SDK_HOST_SYMBOLS: the transformed SDK keys disposal on the host's own symbols and never defines them.
 if (typeof Symbol.dispose !== 'symbol' || typeof Symbol.asyncDispose !== 'symbol') return null;
 // The actual installed SDK version, exact lock integrity, pinned browser/worker/resource bytes, and source-owned
 // HTML/CSP/render program all participate. Server-side transcript/admission algorithm changes bump the family.
 const fingerprint = async (algorithm: string, program: string) => algorithm + ';sha256:' + await sha(encode({
  algorithm, sdkVersion, sdkIntegrity: SDK_INTEGRITY,
  sdkWorkerPolicy: NATIVE_SDK_POLICY_IDENTITY, pdfjsVersion: PDF_VERSION,
  packageDigest: PACKAGE_DIGEST, browser: files.get('/pdfjs/pdf.min.mjs'), worker: files.get('/pdfjs/pdf.worker.min.mjs'),
  program: await sha(encode([HTML, CSP, program])),
 }));
 return { ...bound, origin, files, fingerprint };
}

/** Missing bindings, explicit finite limits or reviewed pins make the port unavailable. No fallback renderer. */
export async function createNativePreviewRenderChecker(o: NativePreviewRenderOptions): Promise<NativePreviewRenderChecker | null> {
 if (!o.budget) return null;
 for (const k of Object.keys(NATIVE_PDF_RENDER_CEILINGS) as (keyof NativePreviewRenderBudget)[]) {
  if (!integer(o.budget[k], NATIVE_PDF_RENDER_CEILINGS[k])) return null;
 }
 if (o.budget.maxRunsPerCasePerDay > o.budget.maxRunsPerClientPerDay) return null;
 const budget = Object.freeze({ ...o.budget });
 const prepared = await prepareRenderer(o);
 if (!prepared) return null;
 const { db, browserBinding, assets, clientId, now, origin, files } = prepared;
 const rendererVersion = await prepared.fingerprint(NATIVE_PDF_RENDERER_ALGORITHM, INSPECTOR);
 const result = (state: RenderResult['state'], reason: string | null, pages: number | null = null) => renderResult(rendererVersion, state, reason, pages);
 const worstMs = budget.maxRunMs + CLEANUP_MS + IDLE_TAIL_MS;
 return { async verify(input) {
  if (!input || input.clientId !== clientId || ![input.caseId, input.candidateId, input.assetId].every(identifier) ||
      typeof input.resultsVersion !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.resultsVersion) ||
      !hash(input.sha256) || !(input.bytes instanceof Uint8Array)) return result('failed', 'invalid-render-input');
  if (input.mediaType !== 'application/pdf') return result('failed', 'unsupported-media-type');
  if (!integer(input.bytes.byteLength, budget.maxFileBytes)) return result('failed', 'file-budget-exceeded');
  // Copy BEFORE the first await: the input object and its byte buffer are not an immutable authority.
  const fixed: RenderInput = { ...input, bytes: new Uint8Array(input.bytes) };
  const stopAt = performance.now() + budget.maxRunMs;
  if (await sha(fixed.bytes) !== fixed.sha256) return result('failed', 'input-integrity-mismatch');
  if (new TextDecoder().decode(fixed.bytes.subarray(0, 5)) !== '%PDF-') return result('failed', 'unsupported-pdf');
  const binding = await sha(encode([clientId, fixed.caseId, fixed.candidateId, fixed.resultsVersion, fixed.assetId, fixed.sha256, fixed.bytes.length, rendererVersion]));
  const scope = { fixed, binding, budget, rendererVersion };
  try {
   const cached = await readReceipt(db, scope);
   if (cached.found) return cached.transcript ? result('rendered', null, cached.transcript.totalPages) : result('pending', 'render-receipt-integrity');
  } catch { return result('pending', 'render-receipt-unavailable'); }
  let timestamp: number;
  try { timestamp = now().getTime(); } catch { return result('pending', 'render-admission-unavailable'); }
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp % DAY_MS + worstMs >= DAY_MS) return result('pending', 'render-admission-unavailable');
  const token = crypto.randomUUID();
  try {
   const primary = db.withSession('first-primary');
   const reserved = await primary.batch([primary.prepare(`INSERT INTO npr_reservations
    (token,client_id,case_id,candidate_id,results_version,asset_id,input_sha256,input_size,renderer_version,binding_sha256,day,started_ms,lease_ms,case_limit,client_limit)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING token`).bind(token, clientId, fixed.caseId, fixed.candidateId, fixed.resultsVersion,
     fixed.assetId, fixed.sha256, fixed.bytes.length, rendererVersion, binding, Math.floor(timestamp / DAY_MS), timestamp,
     worstMs, budget.maxRunsPerCasePerDay, budget.maxRunsPerClientPerDay)]);
   const acknowledgement = reserved[0] as { success?: unknown; results?: { token?: unknown }[] } | undefined;
   const rows = acknowledgement?.results;
   if (reserved.length !== 1 || acknowledgement?.success !== true || !rows || rows.length !== 1 || rows[0]?.token !== token) return result('pending', 'render-admission-unavailable');
  } catch { return result('pending', 'render-admission-refused'); }
  const inspected = await inspect({ ...scope, stopAt, files, origin, browserBinding, assets });
  if (inspected.outcome.state !== 'rendered' || !inspected.transcript) return inspected.outcome;
  try {
   const completed = now().getTime();
   if (!Number.isSafeInteger(completed) || completed < timestamp || completed > timestamp + budget.maxRunMs + CLEANUP_MS) return result('pending', 'render-receipt-unavailable');
   if (!await saveReceipt(db, scope, token, completed, inspected.transcript)) return result('pending', 'render-receipt-unavailable');
  } catch { return result('pending', 'render-receipt-unavailable'); }
  return inspected.outcome;
 } };
}

type PinnedFiles = Map<string, { path: string; bytes: number; sha256: string }>;
type AssetsFetcher = NonNullable<NativePreviewRenderOptions['assets']>;
/** The SDK's fetches only reach the BROWSER binding, never global fetch. Launch/upgrade HTTP is aborted on the deadline. */
function boundBinding(binding: BrowserWorker, o: { signal: AbortSignal; check(): void; late(): boolean; opened(ws: { close(): void }): void }): BrowserWorker {
 return { fetch: async (url, init) => {
  o.check();
  // workerd binds an upgraded socket to its request's signal (AbortableWebSocket), so the deadline reaches an upgrade
  // only while it is in flight; the live transport is closed by release() after owned termination, not by abort.
  const upgrade = new Headers(init?.headers).get('upgrade')?.toLowerCase() === 'websocket';
  const upgrading = new AbortController(), forward = () => upgrading.abort();
  if (upgrade) o.signal.addEventListener('abort', forward, { once: true });
  let response: Response;
  try { response = await binding.fetch(url, { ...init, signal: upgrade ? upgrading.signal : o.signal }); }
  finally { o.signal.removeEventListener('abort', forward); }
  const ws = (response as Response & { webSocket?: { close(): void } }).webSocket;
  if (ws) o.opened(ws);
  if (o.late()) { ws?.close(); throw Error('late launch'); }
  return response;
 } };
}

/**
 * The page's only network: the source-owned document and program, the exact input PDF and pinned same-origin PDF.js files.
 * Every other request, and any request after the check fails, is aborted and reported as a violation. Nothing is continued.
 */
function intercept(a: {
 origin: string; files: PinnedFiles; assets: AssetsFetcher; signal: AbortSignal; program: string; input: Uint8Array;
 cache: Map<string, Promise<Uint8Array>>; statics: { bytes: number };
 isMainFrame(frame: unknown): boolean; check(): void; violate(kind: PreviewFirstViolation): void; acknowledged(): void;
 /**
  * Serve the input as `input/<k>` parts of this many bytes instead of one `input.pdf`, and respond one request at a time
  * through `serial`. The SDK encodes every response body byte by byte, so this bounds that allocation to one part.
  */
 parts?: { bytes: number; serial: { tail: Promise<void> } };
}): (request: HTTPRequest) => Promise<void> {
 let requests = 0;
 return async request => {
  try {
   a.check();
   if (++requests > MAX_REQUESTS) refuse('request-budget');
   if (request.method() !== 'GET') refuse('method');
   const url = new URL(request.url());
   if (url.origin !== a.origin || url.search || url.hash || url.username || url.password) refuse('origin');
   let body: string | Uint8Array, contentType: string, isDocument = false;
   if (url.pathname === DOCUMENT && request.isNavigationRequest() && a.isMainFrame(request.frame())) {
    body = HTML; contentType = 'text/html; charset=utf-8'; isDocument = true;
   } else if (url.pathname === SCRIPT && request.resourceType() === 'script') {
    body = a.program; contentType = 'text/javascript; charset=utf-8';
   } else if (!a.parts && url.pathname === PDF && request.resourceType() === 'fetch') {
    body = a.input; contentType = 'application/pdf';
   } else if (a.parts && PDF_PART.test(url.pathname) && request.resourceType() === 'fetch') {
    const at = Number(url.pathname.slice(PDF_PART_PREFIX.length)) * a.parts.bytes;
    if (at >= a.input.byteLength) refuse('unowned-path');
    body = a.input.subarray(at, at + a.parts.bytes); contentType = 'application/octet-stream';
   } else {
    const pin = a.files.get(url.pathname);
    if (!pin || !['script', 'fetch', 'other'].includes(request.resourceType()) || /(?:LICENSE|pdf-reader\.mjs|pdf-viewer-worker\.mjs)$/.test(url.pathname)) refuse(url.pathname === '/favicon.ico' ? 'favicon-path' : 'unowned-path');
    let pending = a.cache.get(url.pathname);
    if (!pending) {
     a.statics.bytes += pin.bytes;
     if (a.statics.bytes > MAX_STATIC_BYTES) refuse('request-budget');
     pending = (async () => {
      // workerd cannot build a Request with redirect 'error'. 'manual' hands back any 3xx unfollowed, and the status check below refuses it.
      const response = await a.assets.fetch(new Request(a.origin + url.pathname, { method: 'GET', redirect: 'manual', signal: a.signal }));
      if (response.status !== 200 || response.redirected) refuse('static-response');
      const data = await readExact(response, pin.bytes, a.signal);
      if ('sha256:' + await sha(data) !== pin.sha256) refuse('static-integrity');
      return data;
     })();
     a.cache.set(url.pathname, pending);
    }
    body = await pending; contentType = url.pathname.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
   }
   const respond = async () => {
    a.check();
    await request.respond({ status: 200, contentType, body, headers: {
     'content-security-policy': CSP, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
     'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin',
    } });
   };
   if (a.parts) {
    const serial = a.parts.serial, turn = serial.tail;
    let release!: () => void;
    serial.tail = new Promise(resolve => { release = resolve; });
    try { await turn; await respond(); } finally { release(); }
   } else await respond();
   if (isDocument) a.acknowledged();
  } catch (error) {
   a.violate(error instanceof Refused ? error.kind : 'other');
   // Never continue a request, including on handler failure. Never log its URL, exception or bytes.
   await request.abort('blockedbyclient').catch(() => {});
  }
 };
}

/** A whole-operation deadline, NOT just a timeout on navigation or a render-task self-report. */
async function inspect(a: {
 fixed: RenderInput; binding: string; budget: NativePreviewRenderBudget; rendererVersion: string; stopAt: number;
 files: PinnedFiles; origin: string;
 browserBinding: BrowserWorker; assets: NonNullable<NativePreviewRenderOptions['assets']>;
}): Promise<{ outcome: RenderResult; transcript: RenderTranscript | null }> {
 // Assigned BEFORE the phase's first await, so a throw or deadline names the phase that was waiting. Never a message.
 let stage: PreviewRenderStage = 'launch';
 const result = (state: RenderResult['state'], reason: string | null, pages: number | null = null, at = stage) => renderResult(a.rendererVersion, state, reason, pages, state === 'rendered' ? undefined : at);
 let accepted: RenderTranscript | null = null;
 let browser: Browser | undefined, page: Page | undefined, timedOut = false, violated = false;
 // Facts for the failure diagnosis only. None of them reaches a verdict, a limit or a cleanup decision.
 let firstViolation: PreviewFirstViolation | undefined, documentAcknowledged = false, gotoState: PreviewGotoState | undefined, gotoError: PreviewGotoError | undefined;
 const violate = (kind: PreviewFirstViolation) => { violated = true; if (!timedOut) firstViolation ??= kind; };
 // Read once, when the main run ends (deadline or settle) and BEFORE abort and cleanup. A goto, a document acknowledgement or a
 // violation that cleanup itself causes afterwards is not a fact about the run, so it never reaches the result.
 let navigation: PreviewNavigationObservation | undefined, frozen = false;
 const freeze = () => {
  if (frozen) return;
  frozen = true;
  if (gotoState) navigation = { goto: gotoState, documentAcknowledged, ...(firstViolation && { firstViolation }), ...(gotoState === 'rejected' && gotoError && { gotoError }) };
 };
 let transport: { close(): void } | undefined;
 const abort = new AbortController();
 let timeout: ReturnType<typeof setTimeout> | undefined;
 const remaining = () => Math.max(0, a.stopAt - performance.now());
 const check = () => { if (timedOut || remaining() <= 0 || violated) throw Error('inspection refused'); };
 const boundedBinding = boundBinding(a.browserBinding, { signal: abort.signal, check, late: () => timedOut || remaining() <= 0, opened: ws => { transport = ws; } });
 const serve = intercept({ origin: a.origin, files: a.files, assets: a.assets, signal: abort.signal, program: INSPECTOR, input: a.fixed.bytes,
  cache: new Map(), statics: { bytes: 0 }, isMainFrame: frame => frame === page?.mainFrame(), check, violate, acknowledged: () => { documentAcknowledged = true; } });
 const work = async (): Promise<RenderResult> => {
  check();
  stage = 'launch';
  browser = await puppeteer.launch(boundedBinding, { keep_alive: IDLE_TAIL_MS, recording: false, guardrails: { allowedDomains: [] } });
  if (timedOut) {
   // Never call the SDK close callback: it swallows Browser.close failures into console.log.
   void terminateOwnedBrowser(browser, a.stopAt + CLEANUP_MS).finally(() => { try { void browser!.disconnect().catch(() => {}); } catch { /* sanitized late cleanup */ } });
   throw Error('late browser');
  }
  check();
  stage = 'page-setup';
  page = await browser.newPage();
  if (timedOut) { if (performance.now() < a.stopAt + CLEANUP_MS) void page.close({ runBeforeUnload: false }).catch(() => {}); throw Error('late page'); }
  page.setDefaultTimeout(Math.max(1, remaining()));
  page.setDefaultNavigationTimeout(Math.max(1, remaining()));
  await page.setBypassServiceWorker(true);
  await page.setCacheEnabled(false);
  await page.setRequestInterception(true);
  page.on('request', request => { void serve(request); });
  page.on('requestfailed', () => { violate('requestfailed'); });
  page.on('pageerror', () => { violate('pageerror'); });
  page.on('dialog', dialog => { violate('dialog'); void dialog.dismiss().catch(() => {}); });
  page.on('popup', popup => { violate('popup'); if (popup) void popup.close().catch(() => {}); });
  stage = 'navigation';
  gotoState = 'pending';
  try {
   await page.goto(a.origin + DOCUMENT, { waitUntil: 'networkidle0', timeout: Math.max(1, remaining()) });
   gotoState = 'resolved';
  } catch (error) { gotoState = 'rejected'; gotoError = gotoErrorToken(error); throw error; }
  check();
  stage = 'inspection';
  const worker = a.files.get('/pdfjs/pdf.worker.min.mjs')!;
  const transcript: unknown = await page.evaluate(async args => {
   const fn = (window as unknown as { clearcaseNativePdfInspect?: (v: typeof args) => Promise<unknown> }).clearcaseNativePdfInspect;
   if (typeof fn !== 'function') throw Error('inspector unavailable');
   return fn(args);
  }, { binding: a.binding, sha256: a.fixed.sha256, size: a.fixed.bytes.length, maxPages: a.budget.maxPages,
   maxCanvasPixels: a.budget.maxCanvasPixels, maxRunMs: Math.max(1, remaining()), workerBytes: worker.bytes, workerSha256: worker.sha256.slice(7) });
  check();
  accepted = validateTranscript(transcript, a);
  return accepted === null ? result('failed', 'incomplete-render-transcript') : result('rendered', null, accepted.totalPages);
 };
 let outcome: RenderResult;
 try {
  outcome = await Promise.race([work(), new Promise<RenderResult>(resolve => {
   timeout = setTimeout(() => { freeze(); timedOut = true; abort.abort(); resolve(result('failed', 'render-timeout')); }, remaining());
  })]);
 } catch { outcome = result('failed', timedOut || remaining() <= 0 ? 'render-timeout' : 'render-failed'); }
 finally {
  if (timeout) clearTimeout(timeout);
  freeze();
  timedOut = true; abort.abort();
  // Work may complete after a launch timeout. The binding wrapper rejects late upgrades and closes their socket;
  // the SDK cannot issue further HTTP requests. This abort does not reach an established upgrade; disconnect the live
  // transport after bounded explicit cleanup.
  const cleanupDeadline = Math.min(performance.now() + CLEANUP_MS, a.stopAt + CLEANUP_MS);
  let releasing: Promise<boolean> | undefined;
  const release = () => releasing ??= (async () => {
   let okay = true;
   try { transport?.close(); } catch { okay = false; }
   try { if (browser) await browser.disconnect(); } catch { okay = false; }
   return okay;
  })();
  const cleanup = async () => {
   let okay = true, pageTimer: ReturnType<typeof setTimeout> | undefined;
   try {
    // A stuck Target.closeTarget must not prevent the Browser.close attempt.
    if (page) await Promise.race([
     page.close({ runBeforeUnload: false }).catch(() => { okay = false; }),
     new Promise<void>(resolve => { pageTimer = setTimeout(() => { okay = false; resolve(); }, 500); }),
    ]);
   } catch { okay = false; }
   finally { if (pageTimer) clearTimeout(pageTimer); }
   try { if (browser && !await terminateOwnedBrowser(browser, cleanupDeadline)) okay = false; }
   finally { if (!await release()) okay = false; }
   return okay;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
   const closed = await Promise.race([cleanup(), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, cleanupDeadline - performance.now())); })]);
   if (!closed) outcome = result('failed', 'render-cleanup-failed', null, 'cleanup');
  } finally {
   if (timer) clearTimeout(timer);
   // Always release our transport even if cleanup exceeded its budget. This is NOT proof of peer termination.
   // The reservation still includes the full documented 60-second idle tail; no refunds on any outcome.
   void release();
  }
 }
 if (violated && outcome!.state === 'rendered') outcome = result('failed', 'render-failed');
 if (navigation && outcome!.state !== 'rendered') outcome = { ...outcome!, navigation };
 return { outcome: outcome!, transcript: outcome!.state === 'rendered' ? accepted : null };
}

/**
 * Source-owned root CDP command, NOT Browser.close()'s swallowed SDK callback.
 * A matched empty Browser.close reply AND peer disconnection are required, before OUR disconnect/transport close.
 * Missing/errored/late acknowledgement or transport-only closure is unknown, never successful cleanup.
 * Errors cross this boundary only as a boolean; no provider/session data is logged or copied into the result.
 */
async function terminateOwnedBrowser(browser: Browser, deadline: number): Promise<boolean> {
 let timer: ReturnType<typeof setTimeout> | undefined, expired = false, peerClosed = false;
 let resolvePeer!: () => void;
 const peer = new Promise<void>(resolve => { resolvePeer = resolve; });
 const onDisconnected = () => { peerClosed = true; resolvePeer(); };
 const remaining = () => Math.max(0, deadline - performance.now());
 const work = async () => {
  if (expired || remaining() <= 0 || !browser.connected) return false;
  const session = await browser.target().createCDPSession();
  if (expired || remaining() <= 0) return false;
  // Use the ROOT connection, not a page-target command and not the SDK's close callback.
  const connection = session.connection();
  if (!connection || !browser.connected) return false;
  const acknowledgement: unknown = await connection.send('Browser.close', undefined, { timeout: Math.max(1, remaining()) });
  if (!acknowledgement || typeof acknowledgement !== 'object' || Object.getPrototypeOf(acknowledgement) !== Object.prototype || Object.keys(acknowledgement).length !== 0 || expired || remaining() <= 0) return false;
  await peer;
  return !expired && remaining() > 0 && peerClosed && !browser.connected;
 };
 try {
  browser.on('disconnected', onDisconnected);
  return await Promise.race([
   work().catch(() => false),
   new Promise<false>(resolve => { timer = setTimeout(() => { expired = true; resolve(false); }, remaining()); }),
  ]);
 } catch { return false; }
 finally {
  expired = true;
  if (timer) clearTimeout(timer);
  try { browser.off('disconnected', onDisconnected); } catch { return false; }
 }
}

async function readExact(response: Response, size: number, signal: AbortSignal): Promise<Uint8Array> {
 const reader = response.body?.getReader();
 if (!reader) refuse('static-response');
 const cancel = () => { void reader.cancel().catch(() => {}); };
 signal.addEventListener('abort', cancel, { once: true });
 if (signal.aborted) cancel();
 const bytes = new Uint8Array(size);
 let offset = 0;
 try {
  while (true) {
   const next = await reader.read();
   if (next.done) break;
   if (offset + next.value.byteLength > size) refuse('static-response');
   bytes.set(next.value, offset); offset += next.value.byteLength;
  }
  if (offset !== size) refuse('static-response');
  return bytes;
 } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}

function validateTranscript(value: unknown, a: { fixed: RenderInput; binding: string; budget: NativePreviewRenderBudget }): RenderTranscript | null {
 if (!value || typeof value !== 'object') return null;
 const t = value as { binding?: unknown; sha256?: unknown; size?: unknown; pdfjsVersion?: unknown; totalPages?: unknown; pages?: unknown };
 if (t.binding !== a.binding || t.sha256 !== a.fixed.sha256 || t.size !== a.fixed.bytes.length || t.pdfjsVersion !== PDF_VERSION ||
     !Array.isArray(t.pages) || !integer(t.totalPages, a.budget.maxPages) || t.pages.length !== t.totalPages) return null;
 let pixels = 0;
 const pages: PageProof[] = [];
 for (const [i, p] of t.pages.entries()) {
  if (!p || p.number !== i + 1 || !integer(p.width, 4096) || !integer(p.height, 4096) || p.pixelBytes !== p.width * p.height * 4 || !hash(p.pixelSha256)) return null;
  pixels += p.width * p.height;
  pages.push({ number: p.number, width: p.width, height: p.height, pixelBytes: p.pixelBytes, pixelSha256: p.pixelSha256 });
 }
 return pixels <= a.budget.maxCanvasPixels ? { binding: a.binding, sha256: a.fixed.sha256, size: a.fixed.bytes.length, pdfjsVersion: PDF_VERSION, totalPages: t.totalPages, pages } : null;
}

// ---- Scaled PDF evidence (real-export U9) ------------------------------------------------------------------------------
// One bounded step checks a window of a candidate's PDFs. Content receipts settle any document whose bytes were already
// rendered under this renderer, with no byte read and no browser. The rest are rendered in ONE admitted browser session,
// each document in its own browser context and page, checking page 1 and its cited pages only. The page program is the v1
// program with the edits below, so v1's program bytes and its renderer version are unchanged.

export const NATIVE_PDF_EVIDENCE_ALGORITHM = 'clearcase.native-pdf-pages/1';
/** Hard ceilings for Workers Paid; the deployment may only narrow them. See `pdfEvidenceStepCost` for what a step may spend. */
export const NATIVE_PDF_EVIDENCE_CEILINGS: Readonly<NativePdfEvidenceBudget> = Object.freeze({
 maxFileBytes: 16 * 1024 * 1024, maxCheckedPagesPerFile: MAX_CHECKED_PAGES, maxPagePixels: 4096 * 4096, maxDocumentMs: 20_000, maxSessionMs: 60_000,
 maxDocumentsPerStep: 90, maxRendersPerSession: 32, maxSessionBytes: 256 * 1024 * 1024, maxSessionsPerClientPerDay: 96,
});
const PDF_PINNED_FILES = 191, CONTEXT_CLOSE_MS = 1_000;
/** The input reaches the page in parts of this size; with the largest pinned file it bounds one response body. */
const PDF_PART_BYTES = 1024 * 1024, MAX_PINNED_FILE_BYTES = 1_300_000, ENCODE_UNIT_BYTES = Math.max(PDF_PART_BYTES, MAX_PINNED_FILE_BYTES);
/**
 * Bytes the pinned SDK (1.4.0, `HTTPRequest.getResponse`) holds per body byte while it responds: one array slot (8 bytes), the
 * joined string, its base64 and the CDP message that carries it (4/3 each). Responses are serialized, so one body at a time.
 */
const ENCODE_BYTES_PER_BODY_BYTE = 13;
/**
 * Receipt rows one step may accept: two per document considered. The lookup fetches one more to know it must hold. Each row
 * is priced at the renderer's fixed MAX_RECEIPT_ROW_BYTES, not the current citation budget, because rows written under a
 * wider earlier budget are still reused; SQL withholds the payload of any larger row.
 */
const receiptRowsPerStep = (b: NativePdfEvidenceBudget) => 2 * b.maxDocumentsPerStep;

/**
 * Worst case of one step under a budget, for the parent to reserve within Workers Paid's 10,000 subrequests and 128 MB per
 * invocation. At the ceilings: 259 subrequests, 98,028,960 bytes (93.5 MiB, inside a 96 MiB step allowance) and 62 s.
 * - Subrequests: the receipt lookup, the session admission, every attempted read and every sealed receipt (one each per render
 *   at most), launch plus upgrade, and each pinned static file once (ASSETS, cached for the session).
 * - Memory: three copies of the PDF in hand (the reader's, the checker's and the digest's), the cached static bytes, one
 *   response being encoded, and the receipt rows fetched (`receiptBytes`).
 * - Wall time: one absolute step deadline over every read, write and render, plus browser cleanup.
 */
export function pdfEvidenceStepCost(b: NativePdfEvidenceBudget): { subrequests: number; memoryBytes: number; receiptBytes: number; wallMs: number } {
 // Each fetched row is held three times: the D1 reply, the parsed row and the validation parse.
 const receiptBytes = 3 * (receiptRowsPerStep(b) + 1) * MAX_RECEIPT_ROW_BYTES;
 return {
  subrequests: 1 + 1 + b.maxRendersPerSession * 2 + 2 + PDF_PINNED_FILES,
  memoryBytes: 3 * b.maxFileBytes + MAX_STATIC_BYTES + ENCODE_BYTES_PER_BODY_BYTE * ENCODE_UNIT_BYTES + receiptBytes,
  receiptBytes,
  wallMs: b.maxSessionMs + CLEANUP_MS,
 };
}

function editProgram(source: string, edits: readonly (readonly [string, string])[]): string {
 for (const [from, to] of edits) {
  if (source.split(from).length !== 2) throw Error('native PDF page program edit does not match exactly once');
  source = source.replace(from, to);
 }
 return source;
}
const PAGES_INSPECTOR = editProgram(INSPECTOR, [
 ['doc.numPages > a.maxPages', 'doc.numPages > a.maxDocumentPages'],
 ['maxImageSize: a.maxCanvasPixels,', 'maxImageSize: a.maxPagePixels,'],
 ['canvasMaxAreaInBytes: a.maxCanvasPixels * 4,', 'canvasMaxAreaInBytes: a.maxPagePixels * 4,'],
 ['for (let n = 1; n <= doc.numPages; n++) {', 'for (const n of a.pages.filter(n => n <= doc.numPages)) {'],
 ['if (pixels > a.maxCanvasPixels)', 'if (width * height > a.maxPagePixels || pixels > a.maxCanvasPixels)'],
 ["const input = new Uint8Array(await (await fetch('/__clearcase_native_pdf__/input.pdf', { credentials: 'omit', cache: 'no-store', redirect: 'error' })).arrayBuffer());",
  "const input = new Uint8Array(a.size);\n  let at = 0;\n  for (let k = 0; k < a.parts; k++) {\n   const part = new Uint8Array(await (await fetch('/__clearcase_native_pdf__/input/' + k, { credentials: 'omit', cache: 'no-store', redirect: 'error' })).arrayBuffer());\n   if (part.length < 1 || at + part.length > a.size) throw Error('input mismatch');\n   input.set(part, at); at += part.length;\n   check();\n  }\n  if (at !== a.size) throw Error('input mismatch');"],
]);

export interface NativePdfEvidenceOptions extends RendererBindings { budget: NativePdfEvidenceBudget | null }
type StepInput = Parameters<NativePdfEvidenceChecker['step']>[0];
type Planned = { assetId: string; sha256: string; size: number; pages: number[]; read: () => Promise<Uint8Array> };
type Settled = Omit<PdfEvidenceOutcome, 'rendererVersion'>;
type DocumentRun = { transcript: ContentReceipt | null; reason: PreviewReasonCode | null; stage: PreviewRenderStage; fatal: boolean };

function validEvidenceBudget(b: NativePdfEvidenceBudget | null): b is NativePdfEvidenceBudget {
 if (!b) return false;
 for (const k of Object.keys(NATIVE_PDF_EVIDENCE_CEILINGS) as (keyof NativePdfEvidenceBudget)[]) if (!integer(b[k], NATIVE_PDF_EVIDENCE_CEILINGS[k])) return false;
 return b.maxDocumentMs + CONTEXT_CLOSE_MS <= b.maxSessionMs && b.maxFileBytes <= b.maxSessionBytes && b.maxRendersPerSession <= b.maxDocumentsPerStep;
}

/** Missing bindings, an invalid budget or unreviewed pins make the port unavailable. No fallback renderer and no v1 fallback. */
export async function createNativePdfEvidenceChecker(o: NativePdfEvidenceOptions): Promise<NativePdfEvidenceChecker | null> {
 if (!validEvidenceBudget(o.budget)) return null;
 const budget = Object.freeze({ ...o.budget });
 const prepared = await prepareRenderer(o);
 // The memory model assumes no pinned file is a larger response than this; the reviewed pins satisfy it.
 if (!prepared || [...prepared.files.values()].some(f => f.bytes > MAX_PINNED_FILE_BYTES)) return null;
 const rendererVersion = await prepared.fingerprint(NATIVE_PDF_EVIDENCE_ALGORITHM, PAGES_INSPECTOR);
 const leaseMs = budget.maxSessionMs + CLEANUP_MS + IDLE_TAIL_MS;
 const expect = (d: { sha256: string; size: number }) => ({ sha256: d.sha256, size: d.size, rendererVersion, maxPagePixels: budget.maxPagePixels });
 return { rendererVersion, async step(input) {
  // One absolute deadline for the whole step: every read, write, admission and render races it; only cleanup follows it.
  const stepStop = performance.now() + budget.maxSessionMs;
  const bounded = <T>(work: Promise<T>) => beforeDeadline(work, stepStop);
  // Copy every identity, page list and reader BEFORE the first await: the input is not an immutable authority.
  const scope = input && input.clientId === prepared.clientId && [input.caseId, input.candidateId].every(identifier)
   && typeof input.resultsVersion === 'string' && /^sha256:[a-f0-9]{64}$/.test(input.resultsVersion) && Array.isArray(input.documents)
   ? { caseId: input.caseId, candidateId: input.candidateId, resultsVersion: input.resultsVersion } : null;
  const listed = Array.isArray(input?.documents) ? [...input.documents] : [];
  const window = listed.slice(0, budget.maxDocumentsPerStep);
  const settled = new Map<number, Settled>();
  const fail = (i: number, assetId: string, state: RequiredPreviewState, reason: PreviewReasonCode, extra: Partial<Settled> = {}) =>
   settled.set(i, { assetId, state, pages: null, checkedPages: [], reason, receipt: null, ...extra });
  const planned: (Planned | null)[] = window.map((d, i) => {
   const assetId = d && identifier(d.assetId) ? d.assetId : 'invalid';
   if (!d || !identifier(d.assetId) || !hash(d.sha256) || !Number.isSafeInteger(d.size) || d.size < 1 || typeof d.read !== 'function'
    || !Array.isArray(d.citedPages) || !checkedPageSet(d.citedPages, Number.MAX_SAFE_INTEGER)) { fail(i, assetId, 'failed', 'invalid-render-input'); return null; }
   const pages = checkedPageSet(d.citedPages, budget.maxCheckedPagesPerFile);
   if (!pages || d.size > budget.maxFileBytes) { fail(i, assetId, 'failed', 'file-budget-exceeded'); return null; }
   return { assetId, sha256: d.sha256, size: d.size, pages, read: d.read.bind(d) };
  });
  const finish = (sessions: number, stopped: PreviewReasonCode | null = null): PdfEvidenceStep => ({
   outcomes: window.flatMap((_, i) => { const s = settled.get(i); return s ? [{ ...s, rendererVersion }] : []; }),
   remaining: [...window.flatMap((_, i) => settled.has(i) ? [] : [planned[i]!.assetId]),
    ...listed.slice(window.length).map(d => d && identifier(d.assetId) ? d.assetId : 'invalid')],
   sessions, stopped,
  });
  if (!scope) { window.forEach((_, i) => settled.has(i) || fail(i, planned[i]!.assetId, 'failed', 'invalid-render-input')); return finish(0); }

  const db = prepared.db.withSession('first-primary');
  const known = new Map<string, unknown[]>();
  const keyOf = (d: { sha256: string; size: number }) => d.sha256 + ':' + d.size;
  try {
   const rows = await bounded(lookupReceiptRows(db, rendererVersion, [...new Set(planned.flatMap(d => d ? [d.sha256] : []))], receiptRowsPerStep(budget)));
   if (!rows) throw Error('receipt lookup over bound');
   for (const row of rows) { const r = row as { input_sha256?: unknown; input_size?: unknown }; const k = r.input_sha256 + ':' + r.input_size; known.set(k, [...known.get(k) ?? [], row]); }
  } catch (error) {
   if (error instanceof DeadlinePassed) return finish(0, 'render-timeout');
   planned.forEach((d, i) => { if (d) fail(i, d.assetId, 'pending', 'render-receipt-unavailable'); });
   return finish(0);
  }
  /** Settle from receipts, or return false when this document still needs a render. */
  const fromReceipts = (d: Planned, i: number) => {
   const decision = decide(known.get(keyOf(d)) ?? [], expect(d), d.pages);
   if (decision.kind === 'render') return false;
   if (decision.kind === 'integrity') fail(i, d.assetId, 'pending', 'render-receipt-integrity');
   else if (decision.kind === 'out-of-range') fail(i, d.assetId, 'failed', 'page-reference-out-of-range', { pages: decision.receipt.totalPages, receipt: 'reused' });
   else settled.set(i, { assetId: d.assetId, state: 'rendered', pages: decision.receipt.totalPages, checkedPages: d.pages, reason: null, receipt: 'reused' });
   return true;
  };
  const queue = planned.flatMap((d, i) => d && !fromReceipts(d, i) ? [i] : []);
  if (!queue.length) return finish(0);

  const session = createPdfSession({ ...prepared, budget, rendererVersion, leaseMs, scope, stepStop, queue: queue.map(i => planned[i]!) });
  // Every attempted read is charged, whether it returns bytes, throws or is abandoned at the deadline.
  let stopped: PreviewReasonCode | null = null, reads = 0, bytesRead = 0;
  try {
   for (const i of queue) {
    const d = planned[i]!;
    if (fromReceipts(d, i)) continue;
    if (reads >= budget.maxRendersPerSession || bytesRead + d.size > budget.maxSessionBytes || !session.hasTimeFor(budget.maxDocumentMs + CONTEXT_CLOSE_MS)) break;
    reads++; bytesRead += d.size;
    let bytes: Uint8Array;
    try {
     const read = await bounded(d.read());
     bytes = read instanceof Uint8Array ? new Uint8Array(read) : new Uint8Array(0);
    } catch (error) {
     if (error instanceof DeadlinePassed) { stopped = 'render-timeout'; break; }
     fail(i, d.assetId, 'pending', 'render-unavailable'); continue;
    }
    if (bytes.byteLength !== d.size || await sha(bytes) !== d.sha256) { fail(i, d.assetId, 'failed', 'input-integrity-mismatch'); continue; }
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') { fail(i, d.assetId, 'failed', 'unsupported-pdf'); continue; }
    const opened = await session.open();
    if (opened !== null) { stopped = opened; break; }
    const run = await session.inspect(d, bytes);
    if (run.transcript) {
     let sealed: ContentReceipt | null = null;
     try { sealed = await bounded(sealReceipt(db, run.transcript, budget.maxPagePixels)); } catch { sealed = null; }
     if (!sealed) { fail(i, d.assetId, 'pending', 'render-receipt-unavailable'); stopped = 'render-receipt-unavailable'; break; }
     known.set(keyOf(d), [...known.get(keyOf(d)) ?? [], { input_sha256: sealed.sha256, input_size: sealed.size, renderer_version: rendererVersion,
      page_set: JSON.stringify(sealed.pages.map(p => p.number)), page_count: sealed.totalPages, receipt_json: receiptJson(sealed) }]);
     const inRange = d.pages.every(n => n <= sealed.totalPages);
     settled.set(i, inRange
      ? { assetId: d.assetId, state: 'rendered', pages: sealed.totalPages, checkedPages: d.pages, reason: null, receipt: 'created' }
      : { assetId: d.assetId, state: 'failed', pages: sealed.totalPages, checkedPages: [], reason: 'page-reference-out-of-range', receipt: 'created' });
    } else {
     fail(i, d.assetId, 'failed', run.reason ?? 'render-failed', { stage: run.stage });
    }
    if (run.fatal) { stopped = run.reason ?? 'render-failed'; break; }
   }
  } finally {
   if (!await session.close()) stopped ??= 'render-cleanup-failed';
  }
  return finish(session.admitted ? 1 : 0, stopped);
 } };
}

/** A step's absolute deadline passed while it waited; the work it raced is abandoned, never awaited again. */
class DeadlinePassed extends Error {}
function beforeDeadline<T>(work: Promise<T>, stopAt: number): Promise<T> {
 let timer: ReturnType<typeof setTimeout> | undefined;
 return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeadlinePassed()), Math.max(0, stopAt - performance.now())); })])
  .finally(() => clearTimeout(timer));
}

/**
 * One admitted browser session, opened lazily on the first document that needs a render. Admission is one append-only
 * `npr_pdf_sessions` row (migration 0004) committed on the primary before launch; it is never refunded. The row reserves
 * [timestamp, timestamp + lease], and the browser must be gone within it: the session ends at the earlier of the step deadline
 * and timestamp + maxSessionMs by the trusted clock, and an acknowledgement too late for one document launches nothing.
 * Each document runs in a fresh browser context and page that is closed before the next opens, so one document's page never
 * serves another's. A violation, a deadline or a failed context close is fatal to the session: its later documents are left
 * for the next step.
 */
function createPdfSession(a: PreparedRenderer & {
 budget: NativePdfEvidenceBudget; rendererVersion: string; leaseMs: number; stepStop: number;
 scope: { caseId: string; candidateId: string; resultsVersion: string }; queue: readonly Planned[];
}) {
 let browser: Browser | undefined, transport: { close(): void } | undefined, opened: Promise<PreviewReasonCode | null> | undefined;
 let stopAt = a.stepStop, reservedEnd = Infinity, violated = false, closing = false;
 const abort = new AbortController(), cache = new Map<string, Promise<Uint8Array>>(), statics = { bytes: 0 }, serial = { tail: Promise.resolve() };
 const token = crypto.randomUUID();
 const trusted = () => { try { const t = a.now().getTime(); return Number.isSafeInteger(t) ? t : Infinity; } catch { return Infinity; } };
 const remaining = () => Math.max(0, Math.min(stopAt - performance.now(), reservedEnd - trusted()));
 const documentTime = a.budget.maxDocumentMs + CONTEXT_CLOSE_MS;
 const session = {
  admitted: false,
  hasTimeFor: (ms: number) => remaining() >= ms,
  open: () => opened ??= (async (): Promise<PreviewReasonCode | null> => {
   const timestamp = trusted();
   if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp % DAY_MS + a.leaseMs >= DAY_MS) return 'render-admission-unavailable';
   const documents = a.queue.slice(0, a.budget.maxRendersPerSession);
   const manifest = await sha(encode(documents.map(d => [d.assetId, d.sha256, d.size, d.pages])));
   try {
    const primary = a.db.withSession('first-primary');
    const reserved = await beforeDeadline(primary.batch([primary.prepare(`INSERT INTO npr_pdf_sessions
     (token,client_id,case_id,candidate_id,results_version,renderer_version,manifest_sha256,documents,day,started_ms,lease_ms,client_limit)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING token`).bind(token, a.clientId, a.scope.caseId, a.scope.candidateId, a.scope.resultsVersion,
      a.rendererVersion, manifest, documents.length, Math.floor(timestamp / DAY_MS), timestamp, a.leaseMs, a.budget.maxSessionsPerClientPerDay)]), a.stepStop);
    session.admitted = true;
    const acknowledgement = reserved[0] as { success?: unknown; results?: { token?: unknown }[] } | undefined;
    if (reserved.length !== 1 || acknowledgement?.success !== true || acknowledgement.results?.length !== 1 || acknowledgement.results[0]?.token !== token) return 'render-admission-unavailable';
   } catch (error) { return error instanceof DeadlinePassed ? 'render-admission-unavailable' : 'render-admission-refused'; }
   // The lease was measured from `timestamp`, before D1. Whatever the acknowledgement took comes out of this session's time.
   reservedEnd = timestamp + a.budget.maxSessionMs;
   const acknowledged = trusted();
   if (acknowledged < timestamp || remaining() < documentTime) return 'render-admission-unavailable';
   stopAt = Math.min(a.stepStop, performance.now() + (reservedEnd - acknowledged));
   const late = () => closing || remaining() <= 0;
   const check = () => { if (late() || violated) throw Error('session refused'); };
   const binding = boundBinding(a.browserBinding, { signal: abort.signal, check, late, opened: ws => { transport = ws; } });
   let timer: ReturnType<typeof setTimeout> | undefined;
   const launched = puppeteer.launch(binding, { keep_alive: IDLE_TAIL_MS, recording: false, guardrails: { allowedDomains: [] } });
   try {
    browser = await Promise.race([launched, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('launch deadline')), remaining()); })]);
    check();
    return null;
   } catch {
    // A launch that lands after its deadline is still ours: terminate it, never call the SDK's swallowing close callback.
    if (!browser) void launched.then(late => terminateOwnedBrowser(late, performance.now() + CLEANUP_MS).finally(() => late.disconnect().catch(() => {})), () => {});
    return 'render-unavailable';
   } finally { if (timer) clearTimeout(timer); }
  })(),
  inspect: (d: Planned, bytes: Uint8Array) => inspectInContext({ ...a, browser: browser!, bytes, d, token, cache, statics, serial, signal: abort.signal,
   sessionLeft: remaining, sessionViolated: () => violated, violate: () => { violated = true; } }),
  /** Owned termination as in v1, within CLEANUP_MS: a matched Browser.close reply and peer disconnection, then our transport. */
  close: async (): Promise<boolean> => {
   closing = true; abort.abort();
   if (!browser) { try { transport?.close(); } catch { /* nothing else is owned */ } return true; }
   const deadline = performance.now() + CLEANUP_MS, owned = browser;
   let okay = await terminateOwnedBrowser(owned, deadline);
   try { transport?.close(); } catch { okay = false; }
   try { await beforeDeadline(owned.disconnect(), deadline); } catch { okay = false; }
   return okay;
  },
 };
 return session;
}

/** One document in its own context. Only a complete transcript for exactly its in-range checked pages is returned. */
async function inspectInContext(a: PreparedRenderer & {
 budget: NativePdfEvidenceBudget; rendererVersion: string; browser: Browser; bytes: Uint8Array; d: Planned; token: string;
 cache: Map<string, Promise<Uint8Array>>; statics: { bytes: number }; serial: { tail: Promise<void> }; signal: AbortSignal;
 sessionLeft(): number; sessionViolated(): boolean; violate(): void;
}): Promise<DocumentRun> {
 // The context close below must also finish inside the session, so the document's own deadline leaves room for it.
 const stopAt = performance.now() + Math.max(0, Math.min(a.budget.maxDocumentMs, a.sessionLeft() - CONTEXT_CLOSE_MS));
 let stage: PreviewRenderStage = 'page-setup', settled = false, violated = false, expired = false, timer: ReturnType<typeof setTimeout> | undefined;
 let context: Awaited<ReturnType<Browser['createBrowserContext']>> | undefined, page: Page | undefined;
 const remaining = () => Math.max(0, stopAt - performance.now());
 const violate = () => { if (!settled) { violated = true; a.violate(); } };
 const check = () => { if (settled || expired || remaining() <= 0 || a.sessionLeft() <= 0 || violated || a.sessionViolated()) throw Error('inspection refused'); };
 const binding = await sha(encode([a.token, a.d.assetId, a.d.sha256, a.d.size, a.d.pages, a.rendererVersion]));
 const serve = intercept({ origin: a.origin, files: a.files, assets: a.assets, signal: a.signal, program: PAGES_INSPECTOR, input: a.bytes,
  cache: a.cache, statics: a.statics, isMainFrame: frame => frame === page?.mainFrame(), check, violate, acknowledged: () => {},
  parts: { bytes: PDF_PART_BYTES, serial: a.serial } });
 const work = async (): Promise<unknown> => {
  check();
  context = await a.browser.createBrowserContext();
  check();
  page = await context.newPage();
  check();
  page.setDefaultTimeout(Math.max(1, remaining()));
  page.setDefaultNavigationTimeout(Math.max(1, remaining()));
  await page.setBypassServiceWorker(true);
  await page.setCacheEnabled(false);
  await page.setRequestInterception(true);
  page.on('request', request => { void serve(request); });
  page.on('requestfailed', violate);
  page.on('pageerror', violate);
  page.on('dialog', dialog => { violate(); void dialog.dismiss().catch(() => {}); });
  page.on('popup', popup => { violate(); if (popup) void popup.close().catch(() => {}); });
  stage = 'navigation';
  await page.goto(a.origin + DOCUMENT, { waitUntil: 'networkidle0', timeout: Math.max(1, remaining()) });
  check();
  stage = 'inspection';
  const worker = a.files.get('/pdfjs/pdf.worker.min.mjs')!;
  const transcript: unknown = await page.evaluate(async args => {
   const fn = (window as unknown as { clearcaseNativePdfInspect?: (v: typeof args) => Promise<unknown> }).clearcaseNativePdfInspect;
   if (typeof fn !== 'function') throw Error('inspector unavailable');
   return fn(args);
  }, { binding, sha256: a.d.sha256, size: a.d.size, parts: Math.ceil(a.d.size / PDF_PART_BYTES), pages: a.d.pages, maxDocumentPages: MAX_DOCUMENT_PAGES, maxPagePixels: a.budget.maxPagePixels,
   maxCanvasPixels: a.budget.maxPagePixels * a.d.pages.length, maxRunMs: Math.max(1, remaining()), workerBytes: worker.bytes, workerSha256: worker.sha256.slice(7) });
  check();
  return transcript;
 };
 let run: DocumentRun;
 try {
  const transcript = await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(Error('document deadline')); }, remaining()); })]);
  const receipt = pagesTranscript(transcript, { ...a.d, binding, rendererVersion: a.rendererVersion, maxPagePixels: a.budget.maxPagePixels });
  run = receipt ? { transcript: receipt, reason: null, stage, fatal: false } : { transcript: null, reason: 'incomplete-render-transcript', stage, fatal: false };
 } catch {
  const timedOut = expired || remaining() <= 0;
  run = { transcript: null, reason: timedOut ? 'render-timeout' : 'render-failed', stage, fatal: timedOut || violated || a.sessionViolated() };
 } finally {
  if (timer) clearTimeout(timer);
  settled = true;
 }
 // Close this document's context before the next opens. A context that does not close in time ends the session, and the
 // document's own result stands only when nothing went wrong during it.
 let closeTimer: ReturnType<typeof setTimeout> | undefined;
 const closed = !context || await Promise.race([
  context.close().then(() => true, () => false),
  new Promise<false>(resolve => { closeTimer = setTimeout(() => resolve(false), CONTEXT_CLOSE_MS); }),
 ]);
 if (closeTimer) clearTimeout(closeTimer);
 if (violated) return { transcript: null, reason: 'render-failed', stage, fatal: true };
 if (!closed) return { transcript: null, reason: 'render-cleanup-failed', stage: 'cleanup', fatal: true };
 return run;
}

/** The receipt a page transcript proves: exactly the in-range checked pages, the bytes it was given, and the pinned PDF.js. */
function pagesTranscript(value: unknown, d: Planned & { binding: string; rendererVersion: string; maxPagePixels: number }): ContentReceipt | null {
 if (!value || typeof value !== 'object') return null;
 const t = value as Record<string, unknown>;
 if (t.binding !== d.binding || t.sha256 !== d.sha256 || t.size !== d.size || t.pdfjsVersion !== PDF_VERSION || !integer(t.totalPages, MAX_DOCUMENT_PAGES)) return null;
 const totalPages = t.totalPages as number;
 const pages = validPages(t.pages, d.pages.filter(n => n <= totalPages), totalPages, d.maxPagePixels);
 return pages && { sha256: d.sha256, size: d.size, rendererVersion: d.rendererVersion, totalPages, pages };
}
