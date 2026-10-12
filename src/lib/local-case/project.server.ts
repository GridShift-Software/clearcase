// Projector: a validated Candidate (GRS-10's readCandidate) -> the read-model rows the pilot stores next to the
// exact package bytes. Raw values stay raw: row_json is the source chronology row in canonical JSON, unchanged;
// display fields are derived from it in the views, never written back. Nothing is synthesised: no full text from
// excerpts, no inferred dates, no narrative that is not in a dataset. The same projection runs at import and again
// on the freshly revalidated candidate at activation, and the read-model digest must agree.
import { createHash } from 'node:crypto';
import { canonicalJson, readCandidate, type Candidate } from '../case-package/index.ts';
import { isPathKey } from '../case-package/refs.ts';
import type { ChronologyListRow, DocumentStateRow, AttachmentRow, OverviewModel } from './model.ts';

export interface DocumentRowW { ref: string; ord: number; row_json: string; state_json: string; attachments_json: string }
export interface AssetRowW {
	key: string; kind: string; indexed_path: string | null; parent_ref: string | null; member: string | null; ordinal: number | null;
	media_type: string; text_status: string; real_path: string | null; sha256: string | null; size: number | null; status: string; download_only: number;
}
export interface SeedRowW { ord: number; dataset_key: string; seed_id: string; seed_sha256: string; record_json: string }
export interface Expect { documents: number; assets: number; seeds: number; files: number }
export interface Projection {
	documents: DocumentRowW[];
	assets: AssetRowW[];
	seeds: SeedRowW[];
	chronologyJson: string;
	overview: string;
	expect: Expect;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const optStr = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function project(candidate: Candidate, counts: Readonly<Record<string, number>>): Projection {
	const r = readCandidate(candidate);
	const documents: DocumentRowW[] = [];
	const list: ChronologyListRow[] = [];
	// rows are schema-validated, but every value is read as untrusted text
	(r.chronology as readonly unknown[]).forEach((value, ord) => {
		const raw = value as Record<string, unknown>;
		const ref = str(raw.ref);
		const s = r.documentState(ref);
		const state: DocumentStateRow = s
			? { file: s.file, preview: s.preview, text: s.text, mediaType: s.mediaType, flags: [...s.flags],
				original: s.original ? { path: s.original.path, sha256: s.original.sha256, size: s.original.size, mediaType: s.original.mediaType, status: s.original.status, downloadOnly: s.original.downloadOnly } : null,
				self: selfRoute(r, ref) }
			: { file: 'blocked', preview: 'none', text: 'unknown', mediaType: null, flags: ['not-indexed'], original: null, self: null };
		const attachments: AttachmentRow[] = r.attachmentsOf(ref).map((a) => {
			const route = r.resolveAttachment(a.key);
			return {
				key: a.key, member: a.member, ordinal: a.ordinal, mediaType: a.mediaType, kind: a.kind,
				route: route === null ? 'unavailable' : route.route,
				reason: route?.route === 'unavailable' ? route.reason : null,
				via: route && route.route !== 'unavailable' ? route.original.ref : null,
			};
		});
		documents.push({ ref, ord, row_json: canonicalJson(raw), state_json: JSON.stringify(state), attachments_json: JSON.stringify(attachments) });
		list.push({
			ref, ord, date: str(raw.date),
			// BA-04: a date type or provenance is shown only when the source supplies it; v5 supplies neither
			dateType: optStr(raw.date_type), dateSource: optStr(raw.date_source),
			docType: str(raw.doc_type), bundle: str(raw.bundle), subject: str(raw.subject), filename: str(raw.filename),
			sender: str(raw.sender), to: str(raw.to), excerpt: str(raw.excerpt), amount: str(raw.amount),
			alsoIn: Array.isArray(raw.also_in) ? raw.also_in.map(str) : [], url: str(raw.url), textStatus: str(raw.text_status),
			parentRef: optStr(raw.pr) ?? candidate.assets[ref]?.parentRef ?? null,
			file: state.file, preview: state.preview, attachments: attachments.length,
		});
	});
	documents.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

	const assets: AssetRowW[] = Object.keys(candidate.assets).sort().map((key) => {
		const a = candidate.assets[key]!;
		const o = candidate.original(key);
		const status = o ? o.status : a.kind === 'embedded' ? 'embedded' : a.kind === 'missing' ? 'missing' : 'unavailable';
		return {
			key, kind: a.kind,
			indexed_path: a.kind === 'embedded' ? null : a.path,
			parent_ref: a.parentRef ?? null,
			member: a.kind === 'embedded' ? a.member : null,
			ordinal: a.kind === 'embedded' ? a.ordinal : null,
			media_type: a.mediaType, text_status: a.textStatus,
			real_path: o?.path ?? null, sha256: o?.sha256 ?? null, size: o?.size ?? null,
			status, download_only: o?.downloadOnly ? 1 : 0,
		};
	});

	const seeds: SeedRowW[] = r.seeds().map((s, ord) => ({ ord, dataset_key: s.datasetKey, seed_id: s.seedId, seed_sha256: s.seedSha256, record_json: canonicalJson(s.record) }));

	const dated = list.map((x) => x.date).filter((d) => d !== '').sort();
	const matter = r.dataset<{ title?: unknown; short?: unknown; forum?: unknown; storyline?: { h?: unknown; t?: unknown }[]; strategy?: { h?: unknown; t?: unknown }[] }>('matter');
	const heads = (xs: unknown) => (Array.isArray(xs) ? xs.map((x) => ({ h: str((x as { h?: unknown }).h), t: str((x as { t?: unknown }).t) })) : []);
	const meta = r.sourceMeta as Record<string, unknown> | null;
	const quantum = r.dataset<Record<string, unknown>>('quantum');
	const contra = r.dataset<Record<string, unknown>>('contradictions');
	// the overview counts document originals: package files (P- keys: bundle, index, extract and schedule files) are not documents
	const docAssets = assets.filter((a) => !isPathKey(a.key));
	const tallyStatus = (s: string) => docAssets.filter((a) => a.status === s).length;
	const overview: OverviewModel = {
		caseId: candidate.caseId,
		caseLabel: candidate.manifest.case.label ?? null,
		resultsVersion: candidate.resultsVersion,
		inputRevisionId: candidate.inputRevisionId,
		inputKind: candidate.manifest.inputRevision.kind,
		created: candidate.manifest.created,
		producer: `${candidate.manifest.producer.name} ${candidate.manifest.producer.version}`,
		counts: r.derivedCounts(),
		dates: { min: dated[0] ?? null, max: dated.at(-1) ?? null, undated: list.length - dated.length },
		originals: { verified: tallyStatus('verified'), caseMismatch: tallyStatus('case-mismatch'), missing: tallyStatus('missing') + tallyStatus('unavailable'), embedded: tallyStatus('embedded'), downloadOnly: docAssets.filter((a) => a.download_only).length },
		sourceClaims: meta ? Object.fromEntries(Object.entries(meta).filter(([, v]) => typeof v === 'number' || typeof v === 'string').sort(([a], [b]) => (a < b ? -1 : 1))) as Record<string, string | number> : {},
		diagnostics: { ...counts },
		quantum: quantum ? { headlineDue: str(quantum.headline_due), headlineRef: str(quantum.headline_ref), headlineDate: str(quantum.headline_date), invoiceCount: typeof quantum.invoiceCount === 'number' ? quantum.invoiceCount : null } : null,
		contradictions: contra && typeof contra.total === 'number' && typeof contra.highCount === 'number' ? { total: contra.total, highCount: contra.highCount } : null,
		matter: matter ? { title: str(matter.title), short: str(matter.short), forum: str(matter.forum), storyline: heads(matter.storyline), strategy: heads(matter.strategy) } : null,
	};

	return {
		documents, assets, seeds,
		chronologyJson: JSON.stringify(list),
		overview: JSON.stringify(overview),
		expect: { documents: documents.length, assets: assets.length, seeds: seeds.length, files: candidate.paths().length },
	};
}

/** How a document that is itself an attachment reaches its bytes (BA-09); null for an ordinary document. */
function selfRoute(r: ReturnType<typeof readCandidate>, ref: string): DocumentStateRow['self'] {
	const route = r.resolveAttachment(ref);
	if (!route) return null;
	return { route: route.route, parentRef: route.parentRef, reason: route.route === 'unavailable' ? route.reason : null, via: route.route === 'unavailable' ? null : route.original.ref };
}

/**
 * Digest over every projected row of a version in a fixed order. Import and verification feed identical rows, and
 * activation compares it with a fresh projection of the revalidated candidate.
 */
export function readModelDigest(p: { documents: DocumentRowW[]; assets: AssetRowW[]; seeds: SeedRowW[]; chronologyJson: string; overview: string; expect: string }): string {
	const h = createHash('sha256');
	const line = (s: string) => h.update(s).update('\n');
	line('#document');
	for (const d of [...p.documents].sort((a, b) => (a.ref < b.ref ? -1 : 1))) line(JSON.stringify([d.ref, d.ord, d.row_json, d.state_json, d.attachments_json]));
	line('#asset');
	for (const a of [...p.assets].sort((x, y) => (x.key < y.key ? -1 : 1)))
		line(JSON.stringify([a.key, a.kind, a.indexed_path, a.parent_ref, a.member, a.ordinal, a.media_type, a.text_status, a.real_path, a.sha256, a.size, a.status, a.download_only]));
	line('#seed');
	for (const s of [...p.seeds].sort((x, y) => x.ord - y.ord)) line(JSON.stringify([s.ord, s.dataset_key, s.seed_id, s.seed_sha256, s.record_json]));
	line('#chronology'); line(p.chronologyJson);
	line('#overview'); line(p.overview);
	line('#expect'); line(p.expect);
	return 'sha256:' + h.digest('hex');
}
