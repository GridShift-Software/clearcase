import { fail, type Actions, type RequestEvent } from '@sveltejs/kit';
import { shard, publishedVersion } from '$lib/views/hosted/payloads.server';
import { hostedWork } from '$lib/views/hosted/work-adapter.server';
import { authorizeWrite, hostedGuard, writeScope } from '$lib/views/litigation/hosted.server';
import { infoRequiredMerge } from '$lib/views/payloads/info-required';
import type { ViewShards } from '$lib/views/payloads/views';
import { refuse } from '$lib/server/runtime/hosted/http';

const INFO_STORE = 'info-required';

export const load = async ({ locals, params }: Pick<RequestEvent, 'locals' | 'params'>) => {
  const scope = await publishedVersion(locals, params);
  const [payload, work] = await Promise.all([
    shard<ViewShards['info_required_tab']>(locals, params, 'view/info_required_tab.json'),
    locals.userWork.readViewWork({ caseId: scope.caseId, store: INFO_STORE }).catch(refuse),
  ]);
  const rows = work.rows;
  const data = infoRequiredMerge(payload, { rows });
  // The version each item's tick rests on, `none` while it has never been ticked: a tick names the one its page showed.
  const versions = Object.fromEntries(payload.rows.map((r) => [r.key, rows.find((x) => x.rowId === r.key)?.version ?? 'none']));
  return { ...data, versions, base: scope.base, empty: data.rows.length === 0 && rows.length === 0 };
};

// The other checks a page still holds unsaved ride along on a failed save, as locally.
const carried = (f: FormData, keys: ReadonlySet<string>, except: string) => {
  const out: { key: string; done: boolean; message: string }[] = [];
  for (const raw of f.getAll('pending')) {
    try {
      const p = JSON.parse(String(raw));
      const key = String(p.key);
      if (key !== except && keys.has(key) && !out.some((o) => o.key === key)) out.push({ key, done: p.done === true, message: String(p.message ?? 'Not saved.').slice(0, 300) });
    } catch {}
  }
  return out;
};

const SAY = {
  busy: 'Not saved: the store is busy or unavailable. Your choice is kept; try again.',
  refused: 'Not saved: the store refused this check. Your choice is kept.',
  failed: 'Not saved: something went wrong. Your choice is kept; try again.',
};

const CHANGED = 'This was changed by someone else. Reload the page and try again.';

/**
 * A tick sets one row, keyed by its item, to done or not, against the version of the row the page showed (`none` for a row
 * that was never saved): the store refuses it (409) when the row has moved on, so a stale page cannot overwrite newer work. The
 * viewer is refused first and the item must be in the published checklist. The form's operation id goes to the store, so a retry
 * after a failed audit replays the same operation and records the audit instead of writing again.
 */
export const actions: Actions = {
  toggle: async ({ request, params, locals }: RequestEvent) => {
    const { caseId, resultsVersion: rv } = writeScope(params);
    await authorizeWrite(locals, caseId);
    const f = await request.formData();
    const key = String(f.get('key') ?? '');
    const done = f.get('done') === 'true';
    const version = String(f.get('version') ?? '');
    const operationId = String(f.get('operationId') ?? '') || crypto.randomUUID();
    const payload = await shard<ViewShards['info_required_tab']>(locals, params, 'view/info_required_tab.json');
    const pending = carried(f, new Set(payload.rows.map((r) => r.key)), key);
    const item = payload.rows.find((r) => r.key === key);
    if (!item) return fail(400, { key, done, message: 'This item is not in this results version.', pending });
    // a tick that names no version is refused as changed, never run against the row as it is now
    if (!version) return fail(409, { key, done, message: CHANGED, pending });
    const w = hostedWork(locals, caseId, rv, { operationId, version: version === 'none' ? '' : version });
    const r = await hostedGuard('toggle', null, () => w.putRow(caseId, INFO_STORE, key, { item: item.item, done, resultsVersion: rv }), SAY);
    if (!r.ok) return fail(r.failure.status, { key, done, message: r.failure.data.message, pending });
    return { saved: key, done, pending };
  },
};
