/** The bundle builder's PDF engine, a TypeScript port of v5's PDFK: open, assemble, indexOnly. */
export { open, Doc, EncryptedPdfError } from './doc.ts';
export type { PageEntry } from './doc.ts';
export { assemble, indexOnly, drawIndex, stampOps, pageNos, visibleBox } from './assemble.ts';
export type { Assembled, IndexHeader, IndexSpec, Source } from './assemble.ts';
export { textWidth, clean } from './text.ts';
