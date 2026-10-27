// Content receipts for scaled PDF evidence (real-export U9), in `npr_content_receipts` (viewer migration 0003).
// A receipt is an immutable fact about exact bytes under one renderer: the document's page count and a canvas proof for each
// page of one page set. It is keyed by the bytes' SHA-256 and size, the renderer version and the page set, never by candidate,
// so the same bytes in any later candidate reuse it. A row that does not validate in every field holds the document; it is
// never repaired, skipped or replaced.
import type { CloudD1 } from '../../storage/cloud/bindings.ts';

export const CONTENT_RECEIPT_FORMAT = 'clearcase.pdf-content-receipt/1';
/** A sanity bound on a document's page count; only checked pages are rasterised. */
export const MAX_DOCUMENT_PAGES = 100_000;
const MAX_DIMENSION = 4096;
/** Receipt rows read for one step. A step that would read more holds rather than decide on a partial view. */
const MAX_LOOKUP_ROWS = 1000;

export interface PageProof { readonly number: number; readonly width: number; readonly height: number; readonly pixelBytes: number; readonly pixelSha256: string }
export interface ContentReceipt {
 readonly sha256: string;
 readonly size: number;
 readonly rendererVersion: string;
 readonly totalPages: number;
 readonly pages: readonly PageProof[];
}
export type ReceiptDecision =
 | { readonly kind: 'covered'; readonly receipt: ContentReceipt }
 | { readonly kind: 'out-of-range'; readonly receipt: ContentReceipt }
 | { readonly kind: 'render' }
 | { readonly kind: 'integrity' };

const positive = (v: unknown, max: number): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= max;
const hex64 = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

/** Page 1 and every cited page, ascending and distinct; null when a citation is not a positive page number or there are too many. */
export function checkedPageSet(cited: readonly unknown[], maxChecked: number): number[] | null {
 if (!Array.isArray(cited)) return null;
 const set = new Set<number>([1]);
 for (const p of cited) { if (!positive(p, Number.MAX_SAFE_INTEGER)) return null; set.add(p); }
 return set.size <= maxChecked ? [...set].sort((a, b) => a - b) : null;
}

/** The canonical receipt text. Validation rebuilds it and requires byte equality, so no extra key, order or spacing survives. */
export function receiptJson(r: ContentReceipt): string {
 return JSON.stringify({ format: CONTENT_RECEIPT_FORMAT, sha256: r.sha256, size: r.size, rendererVersion: r.rendererVersion, totalPages: r.totalPages,
  pages: r.pages.map(p => ({ number: p.number, width: p.width, height: p.height, pixelBytes: p.pixelBytes, pixelSha256: p.pixelSha256 })) });
}

/** A proof list for exactly `expected` (ascending), each page within the document and the pixel limit. */
export function validPages(value: unknown, expected: readonly number[], totalPages: number, maxPagePixels: number): PageProof[] | null {
 if (!Array.isArray(value) || value.length !== expected.length || expected.length === 0 || expected[0] !== 1) return null;
 const pages: PageProof[] = [];
 for (const [i, p] of value.entries()) {
  if (!p || typeof p !== 'object') return null;
  const { number, width, height, pixelBytes, pixelSha256 } = p as Record<string, unknown>;
  if (number !== expected[i] || !positive(number, totalPages) || !positive(width, MAX_DIMENSION) || !positive(height, MAX_DIMENSION)
   || width * height > maxPagePixels || pixelBytes !== width * height * 4 || !hex64(pixelSha256)) return null;
  pages.push({ number, width, height, pixelBytes, pixelSha256 });
 }
 return pages;
}

/** The receipt a stored row proves for these bytes and this renderer, or null when any field disagrees. */
export function receiptFromRow(row: unknown, expect: { sha256: string; size: number; rendererVersion: string; maxPagePixels: number }): ContentReceipt | null {
 if (!row || typeof row !== 'object') return null;
 const r = row as Record<string, unknown>;
 if (r.input_sha256 !== expect.sha256 || r.input_size !== expect.size || r.renderer_version !== expect.rendererVersion
  || typeof r.page_set !== 'string' || typeof r.receipt_json !== 'string' || !positive(r.page_count, MAX_DOCUMENT_PAGES)) return null;
 try {
  const set: unknown = JSON.parse(r.page_set), body: unknown = JSON.parse(r.receipt_json);
  if (!Array.isArray(set) || !body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.totalPages !== r.page_count || set.some((n, i) => !positive(n, r.page_count as number) || (i > 0 && n <= set[i - 1]))) return null;
  const pages = validPages(b.pages, set as number[], r.page_count as number, expect.maxPagePixels);
  if (!pages) return null;
  const receipt: ContentReceipt = { sha256: expect.sha256, size: expect.size, rendererVersion: expect.rendererVersion, totalPages: r.page_count as number, pages };
  return receiptJson(receipt) === r.receipt_json && JSON.stringify(set) === r.page_set ? receipt : null;
 } catch { return null; }
}

/** Every stored receipt row for these digests under one renderer, in one read; null when the rows would exceed the step's bound. */
export async function lookupReceiptRows(db: CloudD1, rendererVersion: string, digests: readonly string[]): Promise<Record<string, unknown>[] | null> {
 if (!digests.length) return [];
 const { results } = await db.prepare(`SELECT input_sha256,input_size,renderer_version,page_set,page_count,receipt_json FROM npr_content_receipts
  WHERE renderer_version=? AND input_sha256 IN (${digests.map(() => '?').join(',')}) LIMIT ${MAX_LOOKUP_ROWS + 1}`).bind(rendererVersion, ...digests).all<Record<string, unknown>>();
 return results.length > MAX_LOOKUP_ROWS ? null : results;
}

/**
 * What the stored rows for one document's bytes decide. Any row that fails validation holds the document. The page count is a
 * fact of the bytes, so one valid receipt settles an out-of-range citation; a receipt whose page set covers `needed` settles the rest.
 */
export function decide(rows: readonly unknown[], expect: Parameters<typeof receiptFromRow>[1], needed: readonly number[]): ReceiptDecision {
 const receipts: ContentReceipt[] = [];
 for (const row of rows) {
  const receipt = receiptFromRow(row, expect);
  if (!receipt) return { kind: 'integrity' };
  receipts.push(receipt);
 }
 if (!receipts.length) return { kind: 'render' };
 if (receipts.some(r => r.totalPages !== receipts[0]!.totalPages)) return { kind: 'integrity' };
 if (needed.some(n => n > receipts[0]!.totalPages)) return { kind: 'out-of-range', receipt: receipts[0]! };
 const covering = receipts.find(r => needed.every(n => r.pages.some(p => p.number === n)));
 return covering ? { kind: 'covered', receipt: covering } : { kind: 'render' };
}

/**
 * Seal one receipt and read it back in the same transaction. An existing row for the same key is never overwritten (the 0003
 * triggers refuse it); whichever row the readback finds must validate. Null when the write or its readback did not commit cleanly.
 */
export async function sealReceipt(db: CloudD1, receipt: ContentReceipt, maxPagePixels: number): Promise<ContentReceipt | null> {
 const set = JSON.stringify(receipt.pages.map(p => p.number)), json = receiptJson(receipt);
 const key = [receipt.sha256, receipt.size, receipt.rendererVersion, set] as const;
 const written = await db.batch([
  db.prepare(`INSERT INTO npr_content_receipts (input_sha256,input_size,renderer_version,page_set,page_count,receipt_json)
   SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM npr_content_receipts WHERE input_sha256=? AND input_size=? AND renderer_version=? AND page_set=?)`)
   .bind(...key, receipt.totalPages, json, ...key),
  db.prepare(`SELECT input_sha256,input_size,renderer_version,page_set,page_count,receipt_json FROM npr_content_receipts
   WHERE input_sha256=? AND input_size=? AND renderer_version=? AND page_set=?`).bind(...key),
 ]) as { success?: unknown; results?: unknown[] }[];
 if (written.length !== 2 || written.some(ack => ack?.success !== true)) return null;
 const rows = written[1]?.results;
 if (!rows || rows.length !== 1) return null;
 const stored = receiptFromRow(rows[0], { sha256: receipt.sha256, size: receipt.size, rendererVersion: receipt.rendererVersion, maxPagePixels });
 return stored && stored.totalPages === receipt.totalPages ? stored : null;
}
