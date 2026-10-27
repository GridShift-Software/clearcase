import { error, type RequestEvent } from '@sveltejs/kit';
import { Value } from 'typebox/value';
import { Manifest } from '$lib/case-package/schema';
import { sha256Hex } from '$lib/case-package/hash';
import { parseStrictJson } from '$lib/case-package/strict-json';
import { originalAttributions } from '$lib/results/hosted/published-reads';
import { readCase, requireCurrent } from '$lib/views/hosted/case.server';
import { caseHref } from '$lib/views/hosted/paths';
import { recordsContext, recordsOriginals, renderRecords, verifyDatasetBytes } from '$lib/views/hosted/records';
import { refuse } from '$lib/server/runtime/hosted/http';

export async function load({ locals, params }: RequestEvent) {
  const p = params as Record<string, string | undefined>;
  const { caseId, info } = await readCase(locals, p.caseId);
  if (info.publication.kind !== 'published' || info.publication.resultsVersion !== p.resultsVersion) error(403, 'Results are not published.');
  const resultsVersion = await requireCurrent(locals, info, p.resultsVersion);
  const key = p.key;
  if (!key || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key)) error(404, 'Not found.');
  const scope = { caseId, resultsVersion };
  const [version, manifestBytes] = await Promise.all([locals.store.getVersion({ resultsVersion }), locals.store.packageFile({ ...scope, path: 'manifest.json' })]).catch(refuse);
  if (!version || version.case_id !== caseId || !manifestBytes || sha256Hex(manifestBytes) !== version.manifest_sha256) error(503, 'Published results are unavailable.');
  let manifest: unknown;
  try { manifest = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); } catch { error(503, 'Published results are unavailable.'); }
  if (!Value.Check(Manifest, manifest) || manifest.resultsVersion !== resultsVersion || manifest.case.id !== caseId) error(503, 'Published results are unavailable.');
  const entries = manifest.files.filter(f => f.role === 'dataset' && f.key === key);
  if (entries.length !== 1) error(404, 'Not found.');
  const [bytes, attribution, originals] = await Promise.all([
    locals.store.packageFile({ ...scope, path: entries[0]!.path }),
    originalAttributions(locals.store, scope),
    locals.assets.originals({ caseId }),
  ]).catch(refuse);
  if (!bytes) error(503, 'Published results are unavailable.');
  const context = recordsContext(caseId, recordsOriginals(attribution, originals.map(o => o.assetId)));
  try {
    const dataset = verifyDatasetBytes(entries[0]!, bytes);
    return { caseHref: caseHref(caseId), label: info.caseLabel ?? caseId, html: renderRecords(dataset, context).html };
  } catch { error(503, 'Published results are unavailable.'); }
}
