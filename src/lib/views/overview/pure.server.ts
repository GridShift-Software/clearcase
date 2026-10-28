import { citedRefs } from '../../components/cite.ts';
import { caseName } from '../../components/titles.ts';
import { anyDateBasis, documentCounts, resolveRefs } from '../../local-case/documents.server.ts';
import type { OverviewModel } from '../../local-case/model.ts';
import { viewText } from '../../local-case/results.server.ts';
import type { PureInput } from '../payloads/views.ts';

/** The overview without notes, the previous version and the slots (ticket 04): what the operator machine builds into the shard. */
export function overviewPure({ store, vid, vc }: PureInput) {
	const v = store.getVersion(vid);
	if (!v) throw new Error(`unknown results version ${vid}`);
	const overview = JSON.parse(v.overview) as OverviewModel;
	// Values from the package (bundle and type names, META keys) never become object keys in page data: a key such as
	// '__proto__' is refused by the serializer. Tallies and claims travel as [key, value] entries.
	const entries = <T>(m: Record<string, T>) => Object.entries(m);
	const tallies = { byBundle: entries(overview.counts.byBundle), byDocType: entries(overview.counts.byDocType), byTextStatus: entries(overview.counts.byTextStatus), claims: entries(overview.sourceClaims) };
	const { byBundle: _b, byDocType: _t, byTextStatus: _s, ...counts } = overview.counts;
	const { sourceClaims: _c, ...rest } = overview;
	const narrative = overview.matter?.storyline[0]?.t ?? null;
	const documents = documentCounts(store, v.id);
	const params = { docCount: documents.total, bundleCount: Object.keys(overview.counts.byBundle).length, invoiceCount: overview.quantum?.invoiceCount ?? overview.counts.invoices, caseName: caseName(overview) };
	return {
		overview: { ...rest, counts },
		tallies,
		documents,
		content: {
			subtitle: viewText(vc, 'overview', 'subtitle', params),
			kpiDocumentsNote: viewText(vc, 'overview', 'kpiDocumentsNote', params),
			kpiInvoicesNote: viewText(vc, 'overview', 'kpiInvoicesNote', params),
		},
		dateBasisKnown: anyDateBasis(store, v.id),
		originalsCheckedAt: v.stored_at,
		narrative,
		known: narrative ? [...resolveRefs(store, v.id, citedRefs([narrative]))] : [],
	};
}

export type OverviewShard = ReturnType<typeof overviewPure>;
