import puppeteer, { type Browser, type BrowserWorker, type HTTPRequest, type Page } from '@cloudflare/puppeteer';
import { packageVersion as sdkVersion } from '@cloudflare/puppeteer/lib/esm/puppeteer/generated/version.js';
import { NATIVE_RENDER_SDK_POLICY } from '../../../../scripts/native-render-sdk-policy.ts';
import { NATIVE_SDK_POLICY_IDENTITY } from './sdk-build-contract.ts';
import type { ClientId } from '../../server/runtime/contracts.ts';
import type { CloudD1 } from '../../storage/cloud/bindings.ts';
import type { PreviewFirstViolation, PreviewGotoError, PreviewGotoState, PreviewNavigationObservation, PreviewRenderStage } from '../../publication/hosted/preview-outcome.ts';
import type { NativePreviewRenderBudget, NativePreviewRenderChecker } from './render-check-contract.ts';

// Deliberately not an import of the build-time (node:fs) asset preparer. Parent supplies its reviewed inventory.
const PDF_VERSION = '6.4.299';
const PACKAGE_DIGEST = 'sha256:ae9a1328f4de3e2cf14b24d711e34299963dc64c10eab7b1afe849b79846e577';
const READER_DIGEST = 'sha256:308102fbbc79e94d08645ac61b54f2c39550800eb9a163d3e10d31e340aa861d';
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

/** Missing bindings, explicit finite limits or reviewed pins make the port unavailable. No fallback renderer. */
export async function createNativePreviewRenderChecker(o: NativePreviewRenderOptions): Promise<NativePreviewRenderChecker | null> {
 if (!o.db || typeof o.db.withSession !== 'function' || !o.browser || typeof o.browser.fetch !== 'function' ||
     !o.assets || typeof o.assets.fetch !== 'function' || !identifier(o.clientId) || typeof o.now !== 'function' || !o.budget || !o.pins) return null;
 for (const k of Object.keys(NATIVE_PDF_RENDER_CEILINGS) as (keyof NativePreviewRenderBudget)[]) {
  if (!integer(o.budget[k], NATIVE_PDF_RENDER_CEILINGS[k])) return null;
 }
 if (o.budget.maxRunsPerCasePerDay > o.budget.maxRunsPerClientPerDay) return null;
 let origin: string;
 try {
  const url = new URL(o.appOrigin);
  if (url.protocol !== 'https:' || url.origin !== o.appOrigin || url.username || url.password) return null;
  origin = url.origin;
 } catch { return null; }
 const budget = Object.freeze({ ...o.budget }), db = o.db, browserBinding = o.browser, assets = o.assets, clientId = o.clientId, now = o.now;
 const pins = o.pins;
 if (pins.schema !== 'clearcase.hosted-pdf-assets/1' || pins.pdfjsVersion !== PDF_VERSION ||
     pins.packageDigest !== PACKAGE_DIGEST || pins.readerDigest !== READER_DIGEST || !Array.isArray(pins.files) || pins.files.length !== 191) return null;
 const files = new Map<string, { path: string; bytes: number; sha256: string }>();
 for (const f of pins.files) {
  if (!f || typeof f.path !== 'string' || !/^pdfjs\/(?:pdf(?:\.worker)?\.min\.mjs|pdf-reader\.mjs|LICENSE|(?:cmaps|iccs|standard_fonts)\/[A-Za-z0-9_.-]+)$/.test(f.path) ||
      files.has('/' + f.path) || !integer(f.bytes, MAX_STATIC_BYTES) || !/^sha256:[a-f0-9]{64}$/.test(f.sha256)) return null;
  files.set('/' + f.path, { path: f.path, bytes: f.bytes, sha256: f.sha256 });
 }
 const packageFiles = [...files.values()].filter(f => f.path !== 'pdfjs/pdf-reader.mjs').sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
 if ('sha256:' + await sha(encode(packageFiles)) !== PACKAGE_DIGEST || files.get('/pdfjs/pdf-reader.mjs')?.sha256 !== READER_DIGEST) return null;
 if (sdkVersion !== '1.4.0') return null;
 // NATIVE_SDK_HOST_SYMBOLS: the transformed SDK keys disposal on the host's own symbols and never defines them.
 if (typeof Symbol.dispose !== 'symbol' || typeof Symbol.asyncDispose !== 'symbol') return null;
 // The actual installed SDK version, exact lock integrity, pinned browser/worker/resource bytes, and source-owned
 // HTML/CSP/render program all participate. Server-side transcript/admission algorithm changes bump the family above.
 const rendererVersion = NATIVE_PDF_RENDERER_ALGORITHM + ';sha256:' + await sha(encode({
  algorithm: NATIVE_PDF_RENDERER_ALGORITHM, sdkVersion, sdkIntegrity: SDK_INTEGRITY,
  sdkWorkerPolicy: NATIVE_SDK_POLICY_IDENTITY, pdfjsVersion: PDF_VERSION,
  packageDigest: PACKAGE_DIGEST, browser: files.get('/pdfjs/pdf.min.mjs'), worker: files.get('/pdfjs/pdf.worker.min.mjs'),
  program: await sha(encode([HTML, CSP, INSPECTOR])),
 }));
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

/** A whole-operation deadline, NOT just a timeout on navigation or a render-task self-report. */
async function inspect(a: {
 fixed: RenderInput; binding: string; budget: NativePreviewRenderBudget; rendererVersion: string; stopAt: number;
 files: Map<string, { path: string; bytes: number; sha256: string }>; origin: string;
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
 let requests = 0, staticBytes = 0;
 let transport: { close(): void } | undefined;
 const abort = new AbortController();
 let timeout: ReturnType<typeof setTimeout> | undefined;
 const remaining = () => Math.max(0, a.stopAt - performance.now());
 const check = () => { if (timedOut || remaining() <= 0 || violated) throw Error('inspection refused'); };
 const boundedBinding: BrowserWorker = { fetch: async (url, init) => {
  check();
  // The SDK's fetches only reach the BROWSER binding, never global fetch. Abort launch/upgrade HTTP on deadline.
  // workerd binds an upgraded socket to its request's signal (AbortableWebSocket), so the deadline reaches an upgrade
  // only while it is in flight; the live transport is closed by release() after owned termination, not by abort.
  const upgrade = new Headers(init?.headers).get('upgrade')?.toLowerCase() === 'websocket';
  const upgrading = new AbortController(), forward = () => upgrading.abort();
  if (upgrade) abort.signal.addEventListener('abort', forward, { once: true });
  let response: Response;
  try { response = await a.browserBinding.fetch(url, { ...init, signal: upgrade ? upgrading.signal : abort.signal }); }
  finally { abort.signal.removeEventListener('abort', forward); }
  const ws = (response as Response & { webSocket?: { close(): void } }).webSocket;
  if (ws) transport = ws;
  if (timedOut || remaining() <= 0) { ws?.close(); throw Error('late launch'); }
  return response;
 } };
 const cached = new Map<string, Promise<Uint8Array>>();
 const serve = async (request: HTTPRequest) => {
  try {
   check();
   if (++requests > MAX_REQUESTS) refuse('request-budget');
   if (request.method() !== 'GET') refuse('method');
   const url = new URL(request.url());
   if (url.origin !== a.origin || url.search || url.hash || url.username || url.password) refuse('origin');
   let body: string | Uint8Array, contentType: string, isDocument = false;
   if (url.pathname === DOCUMENT && request.isNavigationRequest() && request.frame() === page?.mainFrame()) {
    body = HTML; contentType = 'text/html; charset=utf-8'; isDocument = true;
   } else if (url.pathname === SCRIPT && request.resourceType() === 'script') {
    body = INSPECTOR; contentType = 'text/javascript; charset=utf-8';
   } else if (url.pathname === PDF && request.resourceType() === 'fetch') {
    body = a.fixed.bytes; contentType = 'application/pdf';
   } else {
    const pin = a.files.get(url.pathname);
    if (!pin || !['script', 'fetch', 'other'].includes(request.resourceType()) || /(?:LICENSE|pdf-reader\.mjs)$/.test(url.pathname)) refuse(url.pathname === '/favicon.ico' ? 'favicon-path' : 'unowned-path');
    let pending = cached.get(url.pathname);
    if (!pending) {
     staticBytes += pin.bytes;
     if (staticBytes > MAX_STATIC_BYTES) refuse('request-budget');
     pending = (async () => {
      // workerd cannot build a Request with redirect 'error'. 'manual' hands back any 3xx unfollowed, and the status check below refuses it.
      const response = await a.assets.fetch(new Request(a.origin + url.pathname, { method: 'GET', redirect: 'manual', signal: abort.signal }));
      if (response.status !== 200 || response.redirected) refuse('static-response');
      const data = await readExact(response, pin.bytes, abort.signal);
      if ('sha256:' + await sha(data) !== pin.sha256) refuse('static-integrity');
      return data;
     })();
     cached.set(url.pathname, pending);
    }
    body = await pending; contentType = url.pathname.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
   }
   check();
   await request.respond({ status: 200, contentType, body, headers: {
    'content-security-policy': CSP, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin',
   } });
   if (isDocument) documentAcknowledged = true;
  } catch (error) {
   violate(error instanceof Refused ? error.kind : 'other');
   // Never continue a request, including on handler failure. Never log its URL, exception or bytes.
   await request.abort('blockedbyclient').catch(() => {});
  }
 };
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
