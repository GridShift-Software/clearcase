import { documentRoute, type ServeMode } from '../case-package/browser.ts';
import type { DerivedCounts } from '../case-package/reader.ts';

export interface ChronologyListRow {
	ref: string;
	ord: number;
	date: string;
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
	url: string;
	textStatus: string;
	parentRef: string | null;
	file: 'present' | 'missing' | 'blocked';
	preview: ServeMode | 'none';
	attachments: number;
}

export type SourceRoute = 'direct' | 'parent' | 'unavailable';

export interface DocumentStateRow {
	file: 'present' | 'missing' | 'blocked';
	preview: ServeMode | 'none';
	text: string;
	mediaType: string | null;
	flags: string[];
	original: { path: string; sha256: string; size: number; mediaType: string; status: 'verified' | 'case-mismatch'; downloadOnly: boolean } | null;
	self: { route: SourceRoute; parentRef: string; reason: string | null; via: string | null } | null;
}

export interface OriginalLinks { presentation: 'viewer' | 'inline' | 'text' | 'download' | null; open: string | null; download: string | null; viewer: string | null }

export interface AttachmentRow {
	key: string;
	member: string | null;
	ordinal: number | null;
	mediaType: string;
	kind: 'file' | 'embedded' | 'missing';
	route: SourceRoute;
	reason: string | null;
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
	sourceClaims: Record<string, string | number>;
	diagnostics: Record<string, number>;
	matter: { title: string; short: string; forum: string; storyline: { h: string; t: string }[]; strategy: { h: string; t: string }[] } | null;
	quantum: { headlineDue: string; headlineRef: string; headlineDate: string; invoiceCount: number | null } | null;
	contradictions: { total: number; highCount: number } | null;
}

export interface CaseSummary {
	caseId: string;
	caseLabel: string | null;
	status: 'active' | 'candidate' | 'recovery';
	version: { id: string; importId: number; created: string; storedAt: string; documents: number | null };
	versions: number;
	href: string;
}

export const versionPath = (resultsVersion: string, base = '/v') => `${base}/${encodeURIComponent(resultsVersion)}`;
export const docPath = documentRoute;
