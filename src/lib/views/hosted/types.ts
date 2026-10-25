// Type-only imports for the hosted case views: the runtime contracts and the local read model's row shapes. Nothing
// here is a runtime import, so the hosted graph never reaches the local implementations through this file.
export type { CaseId, CaseInfo, HostedNote, NoteTarget, RequestServices, ResultsStatus, ResultsVersion, Versioned, ViewContentReader, WorkVersion } from '../../server/runtime/contracts.ts';
export type { ChronologyListRow, OverviewModel } from '../../local-case/model.ts';
