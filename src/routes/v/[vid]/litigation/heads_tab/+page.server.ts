import { randomUUID } from 'node:crypto';
import { app } from '$lib/local-case/app.server';
import { resolveRefs } from '$lib/local-case/documents.server';
import { exportFileName, viewContentOf, viewText } from '$lib/local-case/results.server';
import { headsActions } from '$lib/views/litigation/actions.server';
import { HEADS_FIELDS, HEADS_FILE, evidenceTokens, splitRefs, type HeadsValues } from '$lib/views/litigation/heads';
import { STORES, deleteValue, localCtx, orderedRows, text } from '$lib/views/litigation/register.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const a = app();
	const vc = viewContentOf(a.store, version.id);
	const saved = orderedRows(version.caseId, STORES.heads);
	const docs = resolveRefs(a.store, version.id, saved.flatMap((r) => splitRefs(text(r.fields.ref))));
	return {
		rows: saved.map((r) => {
			const v = Object.fromEntries(HEADS_FIELDS.map((k) => [k, text(r.fields[k])])) as HeadsValues;
			return { rowId: r.rowId, del: deleteValue(r.rowId, r.version), ...v, evidence: evidenceTokens(v.ref, (t) => docs.has(t)) };
		}),
		caption: viewText(vc, 'heads_tab', 'exportCaption'),
		exportName: exportFileName(vc, 'heads_tab', HEADS_FILE),
		addId: randomUUID(),
	};
};

export const actions: Actions = headsActions(localCtx);
