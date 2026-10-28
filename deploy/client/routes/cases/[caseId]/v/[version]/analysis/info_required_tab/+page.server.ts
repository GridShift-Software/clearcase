import { fail, type Actions, type RequestEvent } from '@sveltejs/kit';
import { shard, publishedVersion } from '$lib/views/hosted/payloads.server';
import { hostedWork } from '$lib/views/hosted/work-adapter.server';
import { hostedGuard, writeScope } from '$lib/views/litigation/hosted.server';
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
  return { ...data, base: scope.base, empty: data.rows.length === 0 && rows.length === 0 };
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

/**
 * A tick sets one row, keyed by its item, to done or not. The row's version is the store's own, read just before the write, so
 * a tick made in another tab in between is refused (409) instead of overwritten; a tick that leaves the row as it is writes nothing,
 * so a retry of one tick writes once.
 */
export const actions: Actions = {
  toggle: async ({ request, params, locals }: RequestEvent) => {
    const { caseId, resultsVersion: rv } = writeScope(params);
    const f = await request.formData();
    const key = String(f.get('key') ?? '');
    const done = f.get('done') === 'true';
    const [payload, saved] = await Promise.all([
      shard<ViewShards['info_required_tab']>(locals, params, 'view/info_required_tab.json'),
      locals.userWork.readViewWork({ caseId, store: INFO_STORE }).catch((e: unknown) => refuse(e)),
    ]);
    const pending = carried(f, new Set(payload.rows.map((r) => r.key)), key);
    const item = payload.rows.find((r) => r.key === key);
    if (!item) return fail(400, { key, done, message: 'This item is not in this results version.', pending });
    const row = saved.rows.find((r) => r.rowId === key);
    // already as asked (a double click, or a tick another tab made): nothing to write
    if ((row?.fields.done === true) === done) return { saved: key, done, pending };
    const w = hostedWork(locals, caseId, rv, { operationId: crypto.randomUUID(), version: row?.version ?? '' });
    const r = await hostedGuard('toggle', null, () => w.putRow(caseId, INFO_STORE, key, { item: item.item, done, resultsVersion: rv }), SAY);
    if (!r.ok) return fail(r.failure.status, { key, done, message: r.failure.data.message, pending });
    return { saved: key, done, pending };
  },
};
