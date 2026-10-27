// U16 fix 1: a multi-file submission (a set) in the native /2 recovery archive. The archive carries the set's identity, digest
// and membership exactly; restore stages those exact bytes; an archive missing any part of a set is refused before staging.
// Real intake, stager, export and restore over SQLite and R2-shaped doubles; synthetic data only.
import { afterEach, expect, it } from 'vitest';
import { exportNativeCase } from '../../../src/lib/recovery/hosted/export.ts';
import { exportCase } from '../../../src/lib/recovery/hosted/index.ts';
import { parseNativeManifest, verifyNativeExport, type EvidenceRow, type NativeExportManifest } from '../../../src/lib/recovery/hosted/native-evidence.ts';
import { planNativeRestore, applyNativeRestore } from '../../../src/lib/recovery/hosted/restore.ts';
import { canonicalJson, encode, sha256Hex } from '../../../src/lib/recovery/hosted/bytes.ts';
import { fileSetDigest } from '../../../src/lib/submissions/file-set.ts';
import { world, CASE, CLIENT, type World } from '../recovery-native-adapters/world.ts';
import { pdf, setOp, shaOf, submitSet } from '../storage/fixture.ts';
import { nativeWorld, req, type NativeWorld } from './world.ts';

const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.close(); });
const FILES = ['set/a.pdf', 'set/b.pdf', 'set/c.pdf'].map((path, i) => ({ ref: `f${i}`, path, bytes: pdf(`set member ${i}`) }));
const SET_ID = setOp(CASE, 'recovery');
const byKey = (rows: EvidenceRow[], ...keys: string[]) => [...rows].sort((a, b) => { const x = canonicalJson(keys.map((k) => a[k])), y = canonicalJson(keys.map((k) => b[k])); return x < y ? -1 : x > y ? 1 : 0; });
const source = (w: World, table: string) => w.db.rows<EvidenceRow>(`SELECT * FROM ${table} WHERE case_id = ?`, CASE);
async function sourceWorld(o: Parameters<typeof submitSet>[4] = {}) {
  const w = await nativeWorld(); worlds.push(w);
  await submitSet(w, CASE, 'recovery', FILES, o);
  return w;
}
async function exported(w: NativeWorld) {
  const deps = await w.deps(), out = await exportNativeCase(deps, req);
  return { deps, out, t: out.manifest.evidence.tables };
}
async function reseal(w: NativeWorld, key: string, m: NativeExportManifest) {
  const e = m.evidence;
  e.rows = Object.values(e.tables).reduce((n, r) => n + r.length, 0); e.bytes = encode(canonicalJson(e.tables)).length; e.sha256 = await sha256Hex(encode(canonicalJson(e.tables)));
  const bytes = encode(canonicalJson(m)), sha = await sha256Hex(bytes);
  w.bucket.setRaw(key, bytes); w.bucket.objects.get(key)!.sha256 = sha;
  return sha;
}

it('archives a sealed set exactly: its identity, digest, membership, revision and every original', async () => {
  const w = await sourceWorld(), { deps, out, t } = await exported(w);
  expect(t.submissions_set).toEqual(source(w, 'submissions_set'));
  expect(t.submissions_set![0]).toMatchObject({ set_id: SET_ID, state: 'sealed', file_count: 3,
    files_sha256: await fileSetDigest(FILES.map((f) => ({ path: f.path, size: f.bytes.byteLength, sha256: shaOf(f.bytes) }))) });
  expect(byKey(t.submissions_set_member!, 'path_key')).toEqual(byKey(source(w, 'submissions_set_member'), 'path_key'));
  expect(t.submissions_set_member).toHaveLength(3);
  expect(t.submissions_revision!.find((r) => r.operation_id === SET_ID)).toMatchObject({ revision_id: `subrev-${SET_ID}`, file_count: 3 });
  expect(t.submissions_file!.filter((f) => f.revision_id === `subrev-${SET_ID}`).map((f) => f.path).sort()).toEqual(FILES.map((f) => f.path));
  for (const f of FILES) expect(out.manifest.references.some((r) => r.kind === 'original' && r.sha256 === shaOf(f.bytes))).toBe(true);
  await expect(verifyNativeExport(deps, { ...req, expectedManifestSha256: out.manifestSha256 })).resolves.toMatchObject({ manifestSha256: out.manifestSha256 });
});

it('archives an open set with its identity and membership, as its persisted state', async () => {
  const w = await sourceWorld({ seal: false }), { deps, out, t } = await exported(w);
  expect(t.submissions_set).toEqual(source(w, 'submissions_set'));
  expect(t.submissions_set![0]).toMatchObject({ state: 'open', files_sha256: null, sealed_at: null });
  expect(byKey(t.submissions_set_member!, 'path_key')).toEqual(byKey(source(w, 'submissions_set_member'), 'path_key'));
  expect(t.submissions_revision!.some((r) => r.operation_id === SET_ID)).toBe(false);
  await expect(verifyNativeExport(deps, { ...req, expectedManifestSha256: out.manifestSha256 })).resolves.toBeTruthy();
});

it('archives a set that is still sealing, with its revision recorded and its finalized and reserved files', async () => {
  const w = await sourceWorld({ sealStep: { files: 1, bytes: 1 << 20, ms: 60_000 }, sealCalls: 1 }), { deps, out, t } = await exported(w);
  expect(t.submissions_set![0]).toMatchObject({ state: 'sealing', sealed_at: null });
  const states = t.submissions_upload!.filter((u) => t.submissions_set_member!.some((m) => m.operation_id === u.operation_id)).map((u) => u.state).sort();
  expect(states).toEqual(['finalized', 'reserved', 'reserved']);
  await expect(verifyNativeExport(deps, { ...req, expectedManifestSha256: out.manifestSha256 })).resolves.toBeTruthy();
});

it('restores a sealed set archive exactly: the staged manifest is the sealed bytes and carries the same set', async () => {
  const w = await sourceWorld(), target = await world(true, true, true); worlds.push(target);
  w.options.target = target.options;
  const { deps, out } = await exported(w), ref = { ...req, expectedManifestSha256: out.manifestSha256 };
  const plan = await planNativeRestore(deps, ref);
  expect(await applyNativeRestore(deps, { ...ref, confirmedPlanSha256: plan.planSha256, operationId: 'set-restore' })).toMatchObject({ ok: true, activated: false });
  const staged = await deps.target!.objects.get(`restore/${CLIENT}/${CASE}/${req.exportId}/manifest.json`);
  expect(staged).toEqual(await deps.objects!.get(out.manifestKey));
  const back = await parseNativeManifest(staged!, deps.nativeEvidence!.limits);
  for (const table of ['submissions_set', 'submissions_set_member', 'submissions_revision', 'submissions_file', 'submissions_upload'])
    expect(back.evidence.tables[table]).toEqual(out.manifest.evidence.tables[table]);
  for (const r of out.manifest.references) expect(await deps.target!.objects.get(`restore/${CLIENT}/${CASE}/${req.exportId}/${r.blob}`)).toEqual(await deps.objects!.get(out.manifestKey.replace('manifest.json', r.blob)));
});

// The partial-restore class (REVIEW.md): an archive that lacks part of a set, or names a set it does not hold, is refused.
const PARTIAL = ['set-tables-absent', 'set-row-dropped', 'member-dropped', 'member-moved', 'set-file-dropped', 'digest', 'count', 'state-open', 'member-not-final', 'extra-set-file'] as const;
it.each(PARTIAL)('refuses a resealed archive with a %s sealed set, even with a recomputed digest', async (kind) => {
  const w = await sourceWorld(), { deps, out } = await exported(w), m = structuredClone(out.manifest), t = m.evidence.tables;
  const member = t.submissions_set_member![0]!, set = t.submissions_set![0]!, rev = `subrev-${SET_ID}`;
  if (kind === 'set-tables-absent') { delete t.submissions_set; delete t.submissions_set_member; }
  if (kind === 'set-row-dropped') t.submissions_set = [];
  if (kind === 'member-dropped') t.submissions_set_member!.shift();
  if (kind === 'member-moved') member.path_key = 'set/z.pdf';
  if (kind === 'set-file-dropped') t.submissions_file = t.submissions_file!.filter((f) => !(f.revision_id === rev && f.path_key === member.path_key));
  if (kind === 'digest') set.files_sha256 = 'e'.repeat(64);
  if (kind === 'count') { set.file_count = 4; t.submissions_revision!.find((r) => r.revision_id === rev)!.file_count = 4; }
  if (kind === 'state-open') Object.assign(set, { state: 'open', files_sha256: null, sealed_at: null });
  if (kind === 'member-not-final') t.submissions_upload!.find((u) => u.operation_id === member.operation_id)!.state = 'reserved';
  if (kind === 'extra-set-file') t.submissions_file!.push({ ...t.submissions_file!.find((f) => f.revision_id === rev)!, path: 'set/extra.pdf', path_key: 'set/extra.pdf', filename: 'extra.pdf' });
  const sha = await reseal(w, out.manifestKey, m);
  await expect(verifyNativeExport(deps, { ...req, expectedManifestSha256: sha })).rejects.toMatchObject({ code: expect.stringMatching(/^(manifest-invalid|export-incomplete)$/) });
});

it('refuses a partial set archive at restore planning, before any target write', async () => {
  const w = await sourceWorld(), target = await world(true, true, true); worlds.push(target);
  w.options.target = target.options;
  const { deps, out } = await exported(w), m = structuredClone(out.manifest);
  m.evidence.tables.submissions_set_member!.pop();
  const sha = await reseal(w, out.manifestKey, m);
  await expect(planNativeRestore(deps, { ...req, expectedManifestSha256: sha })).rejects.toMatchObject({ code: expect.stringMatching(/^(manifest-invalid|export-incomplete)$/) });
  expect(target.bucket.puts).toEqual([]);
  expect(target.db.rows('SELECT * FROM uw_snapshot')).toEqual([]);
});

// Case-scoped tables the native archive deliberately leaves out, each with its reason. Any other case-scoped table in the
// schema must be archived: a new one fails here instead of being silently missing from a restore.
const NOT_ARCHIVED: Record<string, string> = {
  tenant_case_grants: 'authority, never restored from an archive; restore must not change grants',
  rs_trusted_fingerprint: 'operator trust decisions, re-made on the receiving deployment',
  rs_verification_work: 'a verification rate window, operational state',
};
it('archives every case-scoped table in the schema, or names why it does not', async () => {
  const w = await sourceWorld(), { out } = await exported(w);
  const scoped = w.db.rows<{ name: string }>(`SELECT m.name FROM sqlite_master m WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
      AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) c WHERE c.name = 'case_id') ORDER BY m.name`).map((r) => r.name);
  // User work travels in its own snapshot (uw_*), not in the native evidence.
  const unaccounted = scoped.filter((n) => !n.startsWith('uw_') && !(n in out.manifest.evidence.tables) && !(n in NOT_ARCHIVED));
  expect(unaccounted).toEqual([]);
  for (const n of Object.keys(NOT_ARCHIVED)) expect(out.manifest.evidence.tables[n]).toBeUndefined();
});

it('holds a /1 export of a case that has only an empty open set: /1 cannot represent a set', async () => {
  const w = await world(); worlds.push(w);
  w.db.exec(`INSERT INTO submissions_set (client_id, case_id, set_id, file_count, total_bytes, state, files_sha256, principal_issuer, principal_subject, opened_at, sealed_at)
    VALUES (?, ?, 'set-empty-000000001', 2, 2, 'open', NULL, ?, 'synthetic-editor', ?, NULL)`, CLIENT, CASE, w.resources.deployment.clientIssuer, '2026-10-25T12:00:00.000Z');
  await expect(exportCase(await w.deps(), { caseId: CASE, exportId: 'e1', includeUserWork: true })).rejects.toMatchObject({ code: 'recovery-unavailable' });
});
