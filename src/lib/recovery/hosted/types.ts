// Complete case export and non-destructive recovery primitives (native24). PREPARED/UNVERIFIED: nothing here is wired to a
// route, a real object store or D1; every durable boundary is an injected port and a null port is a 503, never a fallback.
import type { AssetsAccess, AsyncUserWork, AuditSink, CaseId, CaseReader, CaseRevision, ClientId, Identity, OriginalEntry, Profile, Publication, ResultsVersion, VersionInfo } from '../../server/runtime/contracts.ts';

export const EXPORT_FORMAT = 'clearcase.recovery-export/1' as const;

export type RecoveryCode =
  | 'recovery-unavailable' | 'unauthenticated' | 'audit-unavailable' | 'invalid-request' | 'not-found' | 'foreign-input'
  | 'export-exists' | 'export-too-large' | 'export-raced' | 'export-incomplete' | 'export-corrupt' | 'manifest-invalid' | 'manifest-mismatch'
  | 'package-corrupt' | 'target-not-isolated' | 'target-not-empty' | 'stale-state' | 'plan-mismatch' | 'restore-conflict' | 'restore-failed' | 'storage-unavailable';

export interface Limits { maxFiles: number; maxFileBytes: number; maxTotalBytes: number }
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({ maxFiles: 20_000, maxFileBytes: 512 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 * 1024 });

/** A durable, private, client-scoped object store. `putIfAbsent` never overwrites. A test stand-in says so and production refuses it. */
export interface PrivateObjectPort {
  readonly kind: 'durable-private' | 'test-standin';
  /** Trusted controller hook, never request data: after awaited preflight IO, immediately before conditional write. */
  putIfAbsent(a: { key: string; bytes: Uint8Array; sha256: string; beforeCommit?(): Promise<void> }): Promise<{ kind: 'created' } | { kind: 'exists' }>;
  get(key: string): Promise<Uint8Array | null>;
}

/** Published previews are not enumerable through `AssetsAccess`; the production adapter is an integration handoff. */
export interface PreviewCatalog { previewsOf(a: { caseId: CaseId; resultsVersion: ResultsVersion }): Promise<readonly OriginalEntry[]> }

/** Current caller-bound publication policy, never an archived publication flag or a case-level preview grant.
 * Production composition must consult live publication and version entitlement in the receiving client instance.
 * A candidate, withdrawn or superseded client-invisible identity returns false; no policy fault may default to true.
 */
export interface VersionVisibilityPort {
  readonly kind: 'current-policy' | 'test-standin';
  isVisible(a: { identity: Identity; caseId: CaseId; resultsVersion: ResultsVersion }): Promise<boolean>;
}

/** The live case-audit view entitlement (AuditReadGate.caseAudit) of this exact request identity and case. Content grants,
 * staff kind and preview authority never satisfy it. Resolves only when held; a denial is `forbidden`, a fault refuses.
 */
export interface CaseAuditPort {
  readonly kind: 'current-policy' | 'test-standin';
  requireCaseAudit(a: { identity: Identity; caseId: CaseId }): Promise<void>;
}

export type ReaderPort =Pick<CaseReader, 'getCase' | 'versionsOf' | 'activeVersionId' | 'stateRevision' | 'verifyVersion' | 'packageFile' | 'packageFilePaths'>;
export type AssetsPort = Pick<AssetsAccess, 'originals' | 'availability' | 'get'>;

export interface RecoveryDeps {
  profile: Profile; now(): Date; newId(): string;
  identity: Identity; store: ReaderPort; assets: AssetsPort; previews: PreviewCatalog | null;
  visibility: VersionVisibilityPort | null;
  userWork: Pick<AsyncUserWork, 'exportAll'>; audit: AuditSink;
  objects: PrivateObjectPort | null; limits?: Partial<Limits>;
  /** Explicit native /2 capability. Its absence never lifts the legacy native-lineage HOLD. */
  nativeEvidence?: import('./native-evidence.ts').NativeEvidencePort | null;
}

export interface BlobRef { sha256: string; size: number; blob: string }
export interface OriginalRecord extends BlobRef { assetId: string; filename: string; mediaType: string; objectVersion: string; etag: string }
export interface EmbeddedRecord { assetId: string; filename: string; mediaType: string; size: number; unavailable: 'embedded' }
export interface PreviewRecord extends OriginalRecord { resultsVersion: ResultsVersion }
export interface PackageFileRecord extends BlobRef { path: string }
export interface VersionRecord { version: VersionInfo; files: PackageFileRecord[] }
export interface UserWorkRecord extends BlobRef { exportedAt: string; tables: number; rows: number }
export interface Accounting {
  originals: { files: number; bytes: number; embedded: number }; previews: { files: number; bytes: number };
  resultsPackages: { versions: number; files: number; bytes: number }; userWork: { included: boolean; tables: number; rows: number; bytes: number };
  blobs: { distinct: number; bytes: number };
}
export interface ExportManifest {
  format: typeof EXPORT_FORMAT; exportId: string; clientId: ClientId; caseId: CaseId; createdAt: string;
  createdBy: { issuer: string; subject: string; kind: 'client' | 'staff' };
  source: { caseRevision: CaseRevision; publication: Publication; activeVersion: ResultsVersion | null };
  selection: { originals: true; previews: true; resultsPackages: true; userWork: boolean };
  originals: OriginalRecord[]; embedded: EmbeddedRecord[]; previews: PreviewRecord[]; resultsVersions: VersionRecord[]; userWork: UserWorkRecord | null;
  accounting: Accounting;
}
export interface ExportResult { manifest: ExportManifest; manifestSha256: string; manifestKey: string; accounting: Accounting }
