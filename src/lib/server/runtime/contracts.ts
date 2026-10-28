import type { Id, ClientId, CaseId, ResultsVersion, Sha256, SessionId, WorkVersion, CaseRevision } from './ids.ts';
import type { Version, Verification, DocumentRow, ProviderRow, DocumentRowsResult, UserWorkErrorCode, NoteView, NoteSummary, AnchorStatus, RegisterRow, RegisterValue, UserWorkTable, TableDefinition, TableCell, UserWorkExport, ImportResult } from './dto.ts';
import type { DocumentAnchor, SeedRow, SeedOverlay, SeedView } from '../../case-package/user-work.ts';
import type { ViewContentReader } from '../../case-package/view-content.ts';
export type * from './ids.ts';
export type * from './dto.ts';
export type { SeedRow, SeedOverlay, SeedView, ViewContentReader };
export type { JsonValue } from '../../case-package/strict-json.ts';
import type { JsonValue } from '../../case-package/strict-json.ts';
export type Fields = Record<string, RegisterValue>;
export type AddResult = { rowId: string; repeated: boolean };
export type Scope = { caseId: CaseId }; export type VersionScope = Scope & { resultsVersion: ResultsVersion };
export type AuthCode = 'unauthenticated' | 'invalid-session' | 'wrong-client' | 'forbidden' | 'identity-unavailable';
export type ReadCode = 'not-found' | 'invalid-package' | 'integrity' | 'storage-unavailable';
export type AssetCode = 'missing-original' | 'changed-original' | 'range-unsatisfiable' | 'asset-unavailable';
export type WorkCode = UserWorkErrorCode | 'storage-unavailable' | 'snapshot-failed';
export type AuditCode = 'invalid-event' | 'audit-unavailable'; export type RuntimeCode = 'invalid-build' | 'missing-binding' | 'probe-failed';
export interface ContractError<C extends string> extends Error { readonly code: C; readonly retryable: boolean }
export interface Principal { readonly issuer: string; readonly subject: string; readonly kind: 'client' | 'staff' }
export type IdentityState = { kind: 'anonymous'; principal: null; sessionId: null } | { kind: 'verified'; principal: Principal; sessionId: SessionId };
export type CaseOperation = 'read' | 'read-original' | 'read-preview' | 'write-user-work';
export type Identity = IdentityState & { readonly clientId: ClientId; checkRevocation(): Promise<void>; authorize(a: Scope & { operation: CaseOperation }): Promise<void> };
export interface IdentityProvider { authenticate(a: { request: Request }): Promise<Identity> }
export type Publication = { kind: 'none' | 'withdrawn' } | { kind: 'published'; resultsVersion: ResultsVersion };
/** Why a case shows no results: none published yet, the published version withdrawn, or results that cannot be read now. */
export type ResultsStatus = { kind: 'pending' } | { kind: 'withdrawn' } | { kind: 'unavailable'; reason: string };
export interface CaseInfo { caseId: CaseId; caseLabel: string | null; publication: Publication; href: string; documents: number | null }
/** The case's publication pointer: the published version, when it moved there (null before published_at was recorded), the version it replaced, and the hex sha256 of the shard manifest it is served from (null for a version published without shards). */
export interface PublicationRecord { versionId: ResultsVersion; publishedAt: string | null; previousVersionId: ResultsVersion | null; shardManifestSha256: string | null }
export type VersionInfo = Omit<Version, 'id' | 'case_id' | 'input_revision_id' | 'case_folder' | 'case_root' | 'case_dev' | 'case_ino'> & { id: ResultsVersion; case_id: CaseId; input_revision_id: Id<'input-revision'> };
export interface DocumentProvider { id: string; owner: string; rows(a: VersionScope): Promise<readonly ProviderRow[]>; revision(a: VersionScope): Promise<string> }
export interface ProviderRegistry { register(p: DocumentProvider): () => void; list(): readonly Pick<DocumentProvider, 'id' | 'owner'>[] }
export interface CaseReader {
  listCases(): Promise<readonly CaseInfo[]>; getCase(a: Scope): Promise<CaseInfo | null>;
  getVersion(a: { resultsVersion: ResultsVersion }): Promise<VersionInfo | null>; versionsOf(a: Scope): Promise<readonly VersionInfo[]>;
  verifyVersion(a: VersionScope): Promise<Verification>; activeVersionId(a: Scope): Promise<ResultsVersion | null>;
  previousVersion(a: Scope): Promise<ResultsVersion | null>; trustedFor(a: Scope): Promise<ReadonlySet<string>>; stateRevision(a: Scope): Promise<CaseRevision>;
  packageFile(a: VersionScope & { path: string }): Promise<Uint8Array | null>; packageFilePaths(a: VersionScope): Promise<readonly string[]>;
  datasetOf(a: VersionScope & { key: string }): Promise<JsonValue | null>; datasetKeys(a: VersionScope): Promise<readonly string[]>;
  viewContentOf(a: VersionScope): Promise<ViewContentReader>; seeds(a: VersionScope): Promise<readonly SeedRow[]>;
  documentRows(a: VersionScope): Promise<DocumentRowsResult>; documentRow(a: VersionScope & { ref: string }): Promise<DocumentRow | null>;
  documentCounts(a: VersionScope): Promise<{ total: number; imported: number; provided: number; failed: DocumentRowsResult['failed'] }>;
  existingRefs(a: VersionScope & { refs: readonly string[] }): Promise<ReadonlySet<string>>; childDocuments(a: VersionScope & { ref: string }): Promise<readonly DocumentRow[]>;
  fingerprints(a: VersionScope): Promise<readonly { ref: string; sha256: Sha256 }[]>; anyDateBasis(a: VersionScope): Promise<boolean>;
  listJson(a: VersionScope): Promise<{ json: string; etag: string; failed: DocumentRowsResult['failed'] } | null>;
  activeDocumentRows(a: Scope): Promise<DocumentRowsResult & { resultsVersion: ResultsVersion | null }>;
  /** The live publication of the case, or null when nothing is published (none, withdrawn, or a version that is not stored). */
  publication(a: Scope): Promise<PublicationRecord | null>;
  readonly providers: ProviderRegistry;
}
export type AsyncCaseStore = CaseReader;

export type AssetRef = (Scope & { kind: 'original'; assetId: string }) | (VersionScope & { kind: 'preview'; assetId: string });
export interface AssetMetadata { size: number; sha256: Sha256; mediaType: string; filename: string; objectVersion: string; etag: string }
export type AssetAvailability = { kind: 'available'; metadata: AssetMetadata } | { kind: 'unavailable'; reason: 'missing' | 'changed' | 'embedded'; parent: AssetRef | null };
export interface ByteRequest { method: 'GET' | 'HEAD'; range: string | null; ifRange: string | null }
export interface OriginalEntry { assetId: string; filename: string; mediaType: string; size: number }
export interface AssetsAccess {
  /** The case's originals, a case-level input: listed through the case grant alone, with or without a publication. */
  originals(a: Scope): Promise<readonly OriginalEntry[]>;
  availability(a: { asset: AssetRef }): Promise<AssetAvailability>;
  /** `for: 'read'` marks a preflight for a byte read: a refusal is audited as the requested `asset.read-original`/`asset.read-preview`, not `asset.describe`. It still releases no bytes. */
  metadata(a: { asset: AssetRef; for?: 'read' }): Promise<AssetMetadata>;
  links(a: { asset: AssetRef }): Promise<{ originalHref: string; downloadHref: string; viewerHref: string | null }>;
  get(a: { asset: AssetRef; request: ByteRequest }): Promise<Response>; // integrity-checked 200/206/416; HEAD has no body
}
export type Expected = { kind: 'absent' } | { kind: 'match'; version: WorkVersion };
export type Written<T> = { kind: 'written'; value: T; version: WorkVersion; caseRevision: CaseRevision } | { kind: 'stale' } | { kind: 'gone' };
export type Versioned<T> = T & { readonly version: WorkVersion };
export type WriteScope = Scope & { expected: Expected; operationId: string };
export type CreateScope = Scope & { expected: { kind: 'absent' }; operationId: string };
export type UpdateScope = Scope & { expected: { kind: 'match'; version: WorkVersion }; operationId: string };
export type CaseWriteScope = Scope & { expectedRevision: CaseRevision; operationId: string };
export type Anchor = Omit<DocumentAnchor, 'caseId' | 'resultsVersion' | 'sha256'> & { caseId: CaseId; resultsVersion: ResultsVersion; sha256: Sha256 | null };
export type NoteTarget = { kind: 'case' } | { kind: 'document'; anchor: Anchor } | { kind: 'analysis'; resultsVersion: ResultsVersion; section: string };
export type WorkRegisterRow = Omit<RegisterRow, 'anchor'> & { anchor: Anchor | null };
export type HostedNote = Omit<NoteView, 'refAtCreation' | 'resultsVersion' | 'anchorSha256'> & { target: NoteTarget };
export type HostedNoteSummary = Omit<NoteSummary, 'detached'> & { detached: HostedNote[] };
export interface SnapshotStore { put(a: Scope & { snapshot: UserWorkExport; revision: CaseRevision }): Promise<Id<'snapshot'>>; get(a: Scope & { id: Id<'snapshot'> }): Promise<UserWorkExport | null> }
export type RegisterCommand = { kind: 'add'; fields: Fields } | { kind: 'replace'; rowId: string; fields: Fields } | { kind: 'remove'; rowId: string };
export interface AsyncRegisterStore {
  rows(): Promise<readonly Versioned<WorkRegisterRow>[]>;
  add(a: { fields: Fields; operationId: string }): Promise<Written<AddResult>>;
  replace(a: { rowId: string; expected: WorkVersion; fields: Fields; operationId: string }): Promise<Written<void>>;
  remove(a: { rowId: string; expected: WorkVersion; operationId: string }): Promise<Written<boolean>>;
  apply(a: { commands: readonly RegisterCommand[]; expectedRevision: CaseRevision; operationId: string }): Promise<Written<void>>;
}
export interface AsyncSeedStore { views(): Promise<readonly Versioned<SeedView>[]>; remove(a: { seedId: string; expected: WorkVersion; operationId: string }): Promise<Written<boolean> | 'absent'> }
export interface AsyncRegisters { open(a: Scope & { store: string }): AsyncRegisterStore; seeds(a: VersionScope & { datasetKey: string }): AsyncSeedStore }
export interface AsyncUserWork {
  anchorFor(a: VersionScope & { ref: string }): Promise<Anchor>; resolve(a: { anchor: Anchor; into: VersionScope }): Promise<{ status: AnchorStatus; refs: string[] }>;
  notesFor(a: Scope & { target: NoteTarget | null }): Promise<readonly Versioned<HostedNote>[]>; summary(a: Scope & { resultsVersion: ResultsVersion | null }): Promise<HostedNoteSummary>;
  addNote(a: CreateScope & { target: NoteTarget; body: string }): Promise<Written<HostedNote>>; deleteNote(a: UpdateScope & { id: string }): Promise<Written<boolean>>;
  seedRows(a: VersionScope & { datasetKey?: string }): Promise<readonly SeedRow[]>; overlays(a: Scope & { datasetKey?: string }): Promise<readonly Versioned<SeedOverlay>[]>;
  seedViews(a: VersionScope & { datasetKey?: string }): Promise<readonly Versioned<SeedView>[]>; putSeedOverlay(a: WriteScope & { overlay: SeedOverlay }): Promise<Written<void>>;
  listRows(a: Scope & { store: string }): Promise<readonly Versioned<WorkRegisterRow>[]>;
  putRow(a: WriteScope & { store: string; rowId: string | null; fields: Fields; anchor: Anchor | null }): Promise<Written<AddResult>>;
  deleteRow(a: UpdateScope & { store: string; rowId: string }): Promise<Written<boolean>>;
  tables(): Promise<readonly UserWorkTable[]>; defineTable(a: { definition: TableDefinition }): Promise<void>; registerStores(a: Scope): Promise<readonly string[]>;
  listTableRows(a: Scope & { table: string }): Promise<readonly { cells: Record<string, TableCell>; version: WorkVersion }[]>;
  putTableRow(a: WriteScope & { table: string; owner: string; row: Record<string, TableCell> }): Promise<Written<void>>;
  putTableRows(a: CaseWriteScope & { table: string; owner: string; rows: readonly Record<string, TableCell>[] }): Promise<Written<void>>;
  deleteTableRow(a: UpdateScope & { table: string; owner: string; key: Record<string, TableCell> }): Promise<Written<boolean>>;
  exportAll(a: Scope): Promise<UserWorkExport>; importAll(a: CaseWriteScope & { snapshot: UserWorkExport; preRestore: Id<'snapshot'> }): Promise<Written<ImportResult>>;
  readonly snapshots: SnapshotStore; readonly registers: AsyncRegisters;
}

export interface AuditEvent { eventId: string; actor: IdentityState; action: string; object: { kind: string; id: string; caseId: CaseId | null }; version: ResultsVersion | WorkVersion | null; outcome: 'succeeded' | 'denied' | 'failed' | 'refused'; at: string }
/**
 * The audit actor of automated, non-request provisioning (the grant-admin bootstrap). It is NOT an IdentityState: it has no
 * principal, session, issuer or verified claim, authenticates nobody, and no request can present one. `operator` is the
 * provisioning run's own label. Only the trusted provisioning audit port records it; the request AuditSink refuses it.
 */
export interface SystemAuditActor { readonly kind: 'system'; readonly component: 'provisioning'; readonly operator: string }
export type AuditActor = IdentityState | SystemAuditActor;
/** An event whose producer is the provisioning system, never a request. Not appendable through AuditSink. */
export type SystemAuditEvent = Omit<AuditEvent, 'actor'> & { actor: SystemAuditActor };
export interface AuditSink { append(a: AuditEvent): Promise<{ eventId: string }> }
export type Profile = 'production' | 'hosted-gate';
export interface BuildStamp<P extends Profile> { revision: string; dirty: boolean; exported: boolean; builtAt: string; bun: string; buildId: string; target: 'cloudflare'; profile: P }
export interface BindingProbe { ok: boolean; bindings: { DB: boolean; BUCKET: boolean; ASSETS: boolean }; probes: { d1: boolean; r2: boolean } }
export interface TestIdentityOption { clientId: ClientId; subject: string; label: string }
/** The hosted-gate sign-in double: starts a session for one synthetic fixture identity. It carries no authority itself. */
export interface TestIdentityDouble {
  readonly provider: 'test-identity-double';
  options(): Promise<readonly TestIdentityOption[]>;
  signIn(a: { clientId: ClientId; subject: string }): Promise<{ sessionId: SessionId; expiresAt: string }>;
  signOut(a: { sessionId: SessionId }): Promise<void>;
}
export type Runtime = { now(): Date; probe(): Promise<BindingProbe> } & ({ build: Readonly<BuildStamp<'hosted-gate'>>; gate: { runId: string; fixtureSha256: Sha256 }; testIdentity: TestIdentityDouble | null } | { build: Readonly<BuildStamp<'production'>>; gate: null; testIdentity: null });

/**
 * A published version's immutable JSON shards (`views/<rvHex>/<name>` in the client bucket). It does not authorize: the
 * caller has already authorized the case and checked that `resultsVersion` is its current published version. A missing
 * shard is null; storage faults throw `storage-unavailable`.
 */
export interface ShardReader { read(a: VersionScope & { name: string }): Promise<Response | null> }
export interface RequestServices {
  /** The authorized request snapshot; absent on local and legacy adapters. */
  caseRead?: (a: Scope) => Promise<{ caseId: CaseId; info: CaseInfo | null; published: PublicationRecord | null }>;
  identity: Identity; store: CaseReader; assets: AssetsAccess; userWork: AsyncUserWork; audit: AuditSink; runtime: Runtime; shards: ShardReader }
