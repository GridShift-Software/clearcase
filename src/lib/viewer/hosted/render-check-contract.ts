import type {CaseId, ClientId, ResultsVersion} from '../../server/runtime/contracts.ts';
import type {RequiredPreviewState} from '../../publication/hosted/ports.ts';
import type {PreviewNavigationObservation, PreviewReasonCode, PreviewRenderStage} from '../../publication/hosted/preview-outcome.ts';

/** Internal, source-owned renderer evidence. Never deserialize this port or a successful result from request JSON. */
export interface NativePreviewRenderChecker {
 verify(input:Readonly<{
  clientId:ClientId;caseId:CaseId;candidateId:string;resultsVersion:ResultsVersion;
  assetId:string;bytes:Uint8Array;sha256:string;mediaType:string;
 }>):Promise<Readonly<{
  state:RequiredPreviewState;
  rendererVersion:string;
  pages:number|null;
  reason:string|null;
  /** Optional, source-owned phase of a failed or pending run. Diagnostic only; never part of a verdict. */
  stage?:PreviewRenderStage;
  /** Optional, source-owned navigation facts of a failed or pending run that reached `goto`. Diagnostic only; never part of a verdict. */
  navigation?:PreviewNavigationObservation;
 }>>;
}
/** Deployment limits, not caller choices. An absent/invalid budget supplies no renderer. */
export interface NativePreviewRenderBudget {
 maxFileBytes:number;
 maxPages:number;
 maxCanvasPixels:number;
 maxRunMs:number;
 maxRunsPerCasePerDay:number;
 maxRunsPerClientPerDay:number;
}

/**
 * One required PDF of a candidate for scaled evidence (real-export U9). Page 1 is always checked beside the cited pages.
 * `read` returns the exact original bytes; it is called at most once per step, and never when a content receipt covers the document.
 */
export interface PdfEvidenceDocument {
 readonly assetId: string;
 readonly sha256: string;
 readonly size: number;
 readonly citedPages: readonly number[];
 read(): Promise<Uint8Array>;
}
/** The settled evidence for one document. `checkedPages` are the pages a receipt proves rasterised; `pages` is the document's page count. */
export interface PdfEvidenceOutcome {
 readonly assetId: string;
 readonly state: RequiredPreviewState;
 readonly rendererVersion: string;
 readonly pages: number | null;
 readonly checkedPages: readonly number[];
 readonly reason: PreviewReasonCode | null;
 /** `reused` means no byte read and no browser work; `created` means this step rendered and sealed the receipt. */
 readonly receipt: 'reused' | 'created' | null;
 readonly stage?: PreviewRenderStage;
 readonly navigation?: PreviewNavigationObservation;
}
/**
 * One bounded step. Outcomes are in input order for the documents it settled; `remaining` lists, in input order, those it did not
 * reach within its bounds or after its session stopped. Calling again with the remaining documents resumes; so does calling again
 * with all of them, since settled renders are receipts and are reused.
 */
export interface PdfEvidenceStep {
 readonly outcomes: readonly PdfEvidenceOutcome[];
 readonly remaining: readonly string[];
 /** Browser sessions this step admitted: 0 or 1. */
 readonly sessions: number;
 /** Why the step stopped before its bounds (admission, launch, a violation, cleanup or a receipt write), or null. Diagnostic only. */
 readonly stopped: PreviewReasonCode | null;
}
/** Internal, source-owned port, like `NativePreviewRenderChecker`. Never deserialize it or its outcomes from request JSON. */
export interface NativePdfEvidenceChecker {
 readonly rendererVersion: string;
 step(input: Readonly<{ clientId: ClientId; caseId: CaseId; candidateId: string; resultsVersion: ResultsVersion; documents: readonly PdfEvidenceDocument[] }>): Promise<PdfEvidenceStep>;
}
/** Deployment limits for scaled PDF evidence, not caller choices. An absent or invalid budget supplies no checker. */
export interface NativePdfEvidenceBudget {
 /** Bytes of one PDF, held whole in Worker memory while its own context inspects it. */
 maxFileBytes: number;
 /** Distinct pages checked in one PDF: page 1 plus its cited pages. */
 maxCheckedPagesPerFile: number;
 /** Canvas pixels of one checked page. */
 maxPagePixels: number;
 /** Wall time for one document, from its context opening to its transcript. */
 maxDocumentMs: number;
 /** Wall time for one browser session, launch to the last document. */
 maxSessionMs: number;
 /** Documents one step considers; their receipts are looked up in one D1 read. */
 maxDocumentsPerStep: number;
 /** Documents one session renders. */
 maxRendersPerSession: number;
 /** Original bytes one session reads. */
 maxSessionBytes: number;
 maxSessionsPerClientPerDay: number;
}
