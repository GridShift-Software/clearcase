import { isHttpError } from '@sveltejs/kit';
import { app } from '../../local-case/app.server.ts';
import { datasetOf, exportFileName, viewContentOf, viewText } from '../../local-case/results.server.ts';
import { inTurn } from '../../local-case/registers.server.ts';
import type { UserWork } from '../../local-case/user-work.server.ts';
import { evidenceRows } from './rows.server.ts';
import type { ChronologyListRow } from '../../local-case/model.ts';
import type { PureInput } from '../payloads/views.ts';
import { REGISTER_STORE, SEED_DATASET, filingsMerge, rowVersion, type FilingsData, type SeedViewLike } from './filings.ts';
import { filingsActionsOver, type FilingsPort } from './filings-actions.server.ts';

function register(caseId: string, rv: string, w: UserWork = app().userWork) {
	const seeds = w.seedViews(caseId, rv, SEED_DATASET) as SeedViewLike[];
	const rows = w.listRows(caseId, REGISTER_STORE);
	return { seeds, rows };
}

export const REGISTER_STORAGE = "Saved in this case's local work store; imported rows stay as imported and your changes are kept apart from them.";
export const registerIntro = (imported: string | null) => `${imported ?? 'Log each filing and the responding/replying affidavit.'} ${REGISTER_STORAGE}`;

/** The filings view without the register's user work (ticket 04): what the operator machine builds into the shard. */
export function filingsPure({ store, vid, vc }: PureInput) {
	const f = datasetOf<FilingsData>(store, vid, 'filings');
	return {
		groups: f?.groups ?? null,
		// every listed document's file state, so a ref typed into the register resolves without the list
		fileOf: (evidenceRows(store, vid)?.rows ?? []).map((r) => [r.ref, r.file] as [string, ChronologyListRow['file']]),
		content: { subtitle: viewText(vc, 'filings_tab', 'subtitle'), orientation: viewText(vc, 'filings_tab', 'orientation'), registerIntro: registerIntro(viewText(vc, 'filings_tab', 'registerIntro')) },
		exportNames: { filings: exportFileName(vc, 'filings_tab', 'filings.csv'), register: exportFileName(vc, 'filings_tab', 'filing-register.csv', 'registerExportFileName') },
	};
}

export const filingsLoad = async ({ parent, url }: { parent: () => Promise<{ version: { id: string; caseId: string } }>; url: URL }) => {
	const { version } = await parent();
	const a = app();
	const { seeds, rows } = register(version.caseId, version.id);
	return filingsMerge(filingsPure({ store: a.store, vid: version.id, vc: viewContentOf(a.store, version.id) }), { seeds, rows }, url.searchParams.get('edit'));
};

/** The filings register's actions run over the local work store: `w` is the `Work` they run over, the app's own by default. */
export function localFilingsPort({ params }: { params: Record<string, string | undefined> }, w: UserWork = app().userWork): FilingsPort | null {
	const a = app();
	const v = a.store.getVersion(params.vid ?? '');
	if (!v) return null;
	const caseId = v.case_id;
	return {
		caseId,
		queued: (fn) => inTurn(w, caseId, REGISTER_STORE, fn),
		rows: async () => w.listRows(caseId, REGISTER_STORE),
		read: async () => ({ ...register(caseId, v.id, w), overlays: w.overlays(caseId, SEED_DATASET) }),
		addRow: async (fields) => { await w.putRow(caseId, REGISTER_STORE, null, fields); },
		putRow: async (rowId, fields) => { await w.putRow(caseId, REGISTER_STORE, rowId, fields); },
		putOverlay: (seedId, baseSeedSha256, fields) => w.putSeedOverlay({ caseId, datasetKey: SEED_DATASET, seedId, baseSeedSha256, fields }),
		deleteRow: async (rowId) => { await w.deleteRow(caseId, REGISTER_STORE, rowId); },
		deleteVersion: (entry) => rowVersion(entry.fields),
		requireDeleteVersion: false,
		published: async () => {},
		statusOf: (e) => (isHttpError(e) && e.status === 503 ? 503 : 500),
	};
}

export const filingsActions = filingsActionsOver((event) => localFilingsPort(event));
