// Read-model shapes shared by the server projection and the views. Browser-safe: types and pure helpers only.
// Every string here that came from a package is untrusted text: views put it into text nodes, never markup.
import { documentRoute, type ServeMode } from '../case-package/browser.ts';
import type { DerivedCounts } from '../case-package/reader.ts';

/** One chronology list entry, derived from the raw row (which stays stored unchanged). */
export interface ChronologyListRow {
	ref: string;
	/** position in the source dataset: the stable tie-breaker of every sort */
	ord: number;
	/** the source date value exactly as supplied ('' when undated) */
	date: string;
	/** date type and provenance only when the source supplies them (BA-04); never inferred */
	dateType: string | null;
	dateSource: string | null;
	docType: string;
	bundle: string;
	subject: string;
	filename: string;
	sender: string;
	to: string;
	excerpt: string;
	amount: string;
	alsoIn: string[];
	/** the legacy v5 locator, kept as data for the export; never used as a link */
	url: string;
	textStatus: string;
	parentRef: string | null;
	file: 'present' | 'missing' | 'blocked';
	preview: ServeMode | 'none';
	attachments: number;
}

/** BA-09 routes: direct original, through the parent container, or unavailable. */
export type SourceRoute = 'direct' | 'parent' | 'unavailable';

export interface DocumentStateRow {
	file: 'present' | 'missing' | 'blocked';
	preview: ServeMode | 'none';
	text: string;
	mediaType: string | null;
	flags: string[];
	original: { path: string; sha256: string; size: number; mediaType: string; status: 'verified' | 'case-mismatch'; downloadOnly: boolean } | null;
	/** when the document is itself an attachment: how its bytes are reached */
	self: { route: SourceRoute; parentRef: string; reason: string | null; via: string | null } | null;
}

/** Links to one original on the originals site, built by the server (they carry the link capability). */
export interface OriginalLinks { presentation: 'viewer' | 'inline' | 'text' | 'download' | null; open: string | null; download: string | null; viewer: string | null }

export interface AttachmentRow {
	key: string;
	member: string | null;
	ordinal: number | null;
	mediaType: string;
	kind: 'file' | 'embedded' | 'missing';
	route: SourceRoute;
	reason: string | null;
	/** ref of the original that carries the bytes (the parent container for route 'parent') */
	via: string | null;
}

export interface OverviewModel {
	caseId: string;
	caseLabel: string | null;
	resultsVersion: string;
	inputRevisionId: string;
	inputKind: string;
	created: string;
	producer: string;
	counts: DerivedCounts;
	dates: { min: string | null; max: string | null; undated: number };
	originals: { verified: number; caseMismatch: number; missing: number; embedded: number; downloadOnly: number };
	/** scalar source META values, shown as claims next to the derived counts, never trusted */
	sourceClaims: Record<string, string | number>;
	/** diagnostic totals per code from validation */
	diagnostics: Record<string, number>;
	matter: { title: string; short: string; forum: string; storyline: { h: string; t: string }[]; strategy: { h: string; t: string }[] } | null;
	/** source quantum headline values, raw (formatted only for display) */
	quantum: { headlineDue: string; headlineRef: string; headlineDate: string; invoiceCount: number | null } | null;
	contradictions: { total: number; highCount: number } | null;
}

/** Route helpers: results versions are 'sha256:<hex>' and always URL-encoded in paths. */
export const versionPath = (resultsVersion: string) => `/v/${encodeURIComponent(resultsVersion)}`;
/** GRS-10's document route, /v/<rv>/doc/<ref>?page=N. */
export const docPath = documentRoute;
