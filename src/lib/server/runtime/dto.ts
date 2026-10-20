import type { ChronologyListRow, DocumentStateRow } from '../../local-case/model.ts';
import type { DocumentAnchor } from '../../case-package/user-work.ts';

export interface Version {
	id: string; case_id: string; case_label: string | null; input_revision_id: string; created: string; import_id: number;
	case_folder: string; case_root: string; case_dev: string; case_ino: string; verdict: string; stored_at: string;
	manifest_sha256: string; diagnostics_sha256: string; validator_version: string; warning_fingerprints: string;
	expect: string; read_model_sha256: string; overview: string;
}

export type Verification = { ok: boolean; reason?: string; ms: number; checked?: Record<string, number> };

export type AnchorStatus = 'here' | 'exact' | 'ambiguous' | 'missing' | 'unanchored';
export interface NoteView {
	id: string;
	body: string;
	createdAt: string;
	refAtCreation: string;
	resultsVersion: string;
	anchorSha256: string | null;
	status: AnchorStatus;
	candidates: string[];
	intact: boolean;
}
export interface NoteSummary { total: number; here: number; exact: number; ambiguous: number; missing: number; unanchored: number; byRef: { ref: string; n: number; status: AnchorStatus }[]; detached: NoteView[] }

export interface RegisterRow { rowId: string; store: string; anchor: DocumentAnchor | null; fields: Record<string, RegisterValue>; createdAt: string; updatedAt: string; intact: boolean }
export type RegisterValue = string | number | boolean | null;


export type TableKind = 'user-work' | 'activation' | 'unregistered';
export type TableScope = 'case' | 'store';
export interface TableColumn { name: string; type: string; notNull: boolean; pk: number }
export interface UserWorkTable { name: string; kind: TableKind; scope: TableScope; owner: string; description: string; columns: TableColumn[] }
export interface TableDefinition {
	name: string; owner: string; description: string;
	columns: { name: string; type: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB'; notNull?: boolean }[];
	primaryKey: string[];
	scope: TableScope;
}
export type TableCell = string | number | null | { $b64: string } | { $int: string };
type Cell = TableCell;
export interface UserWorkExport {
	format: 'clearcase.user-work/1';
	exportedAt: string;
	tables: (UserWorkTable & { rows: Record<string, Cell>[] })[];
	excluded?: { name: string; kind: TableKind; rows: number; reason: string }[];
}

export type UserWorkErrorCode = 'invalid' | 'restore-state' | 'restore-key' | 'restore-key-collision' | 'table-conflict' | 'table-built-in';

export type TableRestore = 'replaced-for-cases' | 'no-cases' | 'merged' | 'replaced' | 'dropped' | 'cleared-for-cases' | 'kept-excluded';
export interface TableRestoreReport { name: string; scope: TableScope; action: TableRestore; rows: number; deleted: number; inserted?: number; replaced?: number; cases?: string[] }
export interface ImportResult {
	tables: number; rows: number; cases: string[]; restored: TableRestoreReport[];
	dropped?: { name: string; rows: number; reason: 'a restore never creates trust: accepted warnings are acknowledged again' }[];
}


export type DocumentSource = 'results' | `provider:${string}`;
export interface DocumentRow {
	ref: string;
	ord: number;
	source: DocumentSource;
	row: Readonly<Record<string, unknown>>;
	list: Readonly<ChronologyListRow>;
	state: Readonly<DocumentStateRow>;
}
export interface ProviderRow { ref: string; row: Record<string, unknown>; list: Omit<ChronologyListRow, 'ord'>; state: DocumentStateRow }

export type DropReason =
	| 'the ref already names a document of this version'
	| 'the list entry names another ref'
	| 'the original was left out: a present original needs a path, size, sha256 and media type'
	| `malformed row: ${string}`;
export interface DocumentRowsResult {
	rows: readonly DocumentRow[];
	dropped: { source: DocumentSource; ref: string; reason: DropReason }[];
	failed: { source: DocumentSource; owner: string; reason: string }[];
}
