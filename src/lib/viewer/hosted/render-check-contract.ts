import type {CaseId, ClientId, ResultsVersion} from '../../server/runtime/contracts.ts';
import type {RequiredPreviewState} from '../../publication/hosted/ports.ts';
import type {PreviewRenderStage} from '../../publication/hosted/preview-outcome.ts';

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
