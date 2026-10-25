// Adverse source and retained-archive tests at public recovery seams, using only synthetic transports.
import { afterEach, expect, it } from 'vitest';
import { exportNativeCase } from '../../../src/lib/recovery/hosted/export.ts';
import { parseNativeManifest, verifyNativeExport, type NativeExportManifest } from '../../../src/lib/recovery/hosted/native-evidence.ts';
import { canonicalJson, encode, sha256Hex } from '../../../src/lib/recovery/hosted/bytes.ts';
import { world, CASE, type World } from '../recovery-native-adapters/world.ts';
import { nativeWorld, req, POLICY, type NativeWorld } from './world.ts';
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.close(); });
async function setup(correction = false) { const w = await nativeWorld(correction); worlds.push(w); return w; }
async function rewrite(w: NativeWorld, key: string, manifest: NativeExportManifest) {
  const e = manifest.evidence;
  e.rows = Object.values(e.tables).reduce((n, r) => n + r.length, 0); e.bytes = encode(canonicalJson(e.tables)).length; e.sha256 = await sha256Hex(encode(canonicalJson(e.tables)));
  const bytes = encode(canonicalJson(manifest)), sha = await sha256Hex(bytes);
  w.bucket.setRaw(key, bytes); w.bucket.objects.get(key)!.sha256 = sha;
  return sha;
}
it.each(['maxLineageRows', 'maxLineageBytes'] as const)('requires finite explicit %s with no defaults', async (key) => {
  const w = await setup();
  for (const value of [undefined, null, 0, -1, NaN, Infinity, 1.2, Number.MAX_SAFE_INTEGER]) {
    Object.assign(w.options.nativeEvidence!, { [key]: value });
    await expect(w.deps()).rejects.toMatchObject({ code: 'recovery-unavailable' });
  }
});
it.each(['rows', 'bytes', 'manifest', 'files'] as const)('refuses %s overflow without a completion manifest', async (kind) => {
  const w = await setup();
  if (kind === 'rows') w.options.nativeEvidence!.maxLineageRows = 1;
  if (kind === 'bytes') w.options.nativeEvidence!.maxLineageBytes = 64;
  if (kind === 'manifest') w.options.limits.maxManifestBytes = 1024;
  if (kind === 'files') w.options.limits.maxFiles = 1;
  await expect(exportNativeCase(await w.deps(), req)).rejects.toMatchObject({ code: 'export-too-large' });
  expect(w.bucket.puts.some((k) => k.includes('/native-e1/'))).toBe(false);
});
it('requires a primary batch; never substitutes alternating reads', async () => {
  const w = await setup(), primary = w.resources.db.withSession;
  w.resources.db.withSession = () => ({ prepare: w.db.prepare.bind(w.db) }) as ReturnType<typeof primary>;
  await expect(w.deps()).rejects.toMatchObject({ code: 'recovery-unavailable' });
  expect(w.bucket.puts.some((k) => k.includes('/native-e1/'))).toBe(false);
});
it('one transactional evidence batch binds all components even if publication changes just after it', async () => {
  const w = await setup(), batch = w.db.batch.bind(w.db); let captures = 0;
  w.db.batch = async (s) => {
    const rows = await batch(s);
    if (s.length === 40) { captures++; w.db.exec("UPDATE rs_publication SET state = 'withdrawn' WHERE case_id = ?", CASE); }
    return rows;
  };
  // Use the default current-publication policy: a fresh authority check refuses the now-hidden exact version.
  w.options.nativeEvidence = { ...POLICY };
  await expect(exportNativeCase(await w.deps(), req)).rejects.toMatchObject({ code: 'not-found' });
  expect(captures).toBe(1);
  expect(w.bucket.puts.some((k) => k.includes('/native-e1/'))).toBe(false);
});
it('refuses foreign-case rows returned by a faulty source batch', async () => {
  const w = await setup(), batch = w.db.batch.bind(w.db);
  w.db.batch = async (s) => {
    const out = await batch(s);
    if (s.length === 40) for (const r of out as { results: Record<string, unknown>[] }[]) for (const row of r.results) if ('candidate_id' in row && 'origin' in row) row.case_id = 'foreign-case';
    return out;
  };
  await expect(exportNativeCase(await w.deps(), req)).rejects.toMatchObject({ code: 'foreign-input' });
});
it.each(['missing', 'changed', 'metadata', 'overrun'] as const)('refuses %s immutable source reference before completion', async (kind) => {
  const w = await setup();
  const row = w.db.rows<{ object_key: string }>('SELECT object_key FROM rs_package_file WHERE path = ?', 'assets.json')[0]!;
  if (kind === 'missing') w.bucket.objects.delete(row.object_key);
  if (kind === 'changed') w.bucket.tamper(row.object_key, (bytes) => { bytes[0] ^= 1; return bytes; });
  if (kind === 'metadata') w.bucket.alter = (key, o) => key === row.object_key ? { ...o, version: '' } : o;
  if (kind === 'overrun') w.bucket.alter = (key, o) => key === row.object_key ? { ...o, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(o.size + 1)); c.close(); } }) } : o;
  await expect(exportNativeCase(await w.deps(), req)).rejects.toMatchObject({ code: kind === 'missing' ? 'export-incomplete' : 'export-corrupt' });
  expect(w.bucket.puts.some((k) => k.includes('/native-e1/'))).toBe(false);
});
it('default publication policy does not silently strip correction parent/private versions', async () => {
  const w = await setup(true); w.options.nativeEvidence = { ...POLICY };
  await expect(exportNativeCase(await w.deps(), req)).rejects.toMatchObject({ code: 'not-found' });
  expect(w.bucket.puts.some((k) => k.includes('/native-e1/'))).toBe(false);
});
it.each(['format', 'evidence-format', 'foreign-case', 'link-id', 'submission-digest', 'submission-revision', 'file-binding', 'correction', 'audit-actor', 'audit-missing', 'reference-missing', 'unknown-field', 'duplicate-row', 'object-key'] as const)('refuses resealed %s evidence, even with a recomputed outer digest', async (kind) => {
  const w = await setup(true), deps = await w.deps(), out = await exportNativeCase(deps, req), m = structuredClone(out.manifest);
  const t = m.evidence.tables;
  if (kind === 'format') Object.assign(m, { format: 'clearcase.recovery-export/99' });
  if (kind === 'evidence-format') Object.assign(m.evidence, { format: 'clearcase.native-evidence/99' });
  if (kind === 'foreign-case') t.native_candidate![0]!.case_id = 'case-foreign';
  if (kind === 'link-id') t.native_import_link![0]!.link_id = 'other-persisted-link';
  if (kind === 'submission-digest') t.native_import_link![0]!.submission_manifest_sha256 = 'a'.repeat(64);
  if (kind === 'submission-revision') t.native_import_link![0]!.submission_revision_id = t.native_import_link![0]!.input_revision_id;
  if (kind === 'file-binding') t.submissions_file![0]!.path = 'other/source.pdf';
  if (kind === 'correction') t.native_correction_change![0]!.before_sha256 = 'a'.repeat(64);
  if (kind === 'audit-actor') t.native_candidate_audit_intent![0]!.archival_event = String(t.native_candidate_audit_intent![0]!.archival_event).replace('historical', 'verified');
  if (kind === 'audit-missing') t.native_candidate_audit_intent = [];
  if (kind === 'reference-missing') m.references.pop();
  if (kind === 'unknown-field') Object.assign(t.native_candidate![0]!, { sql: 'DROP TABLE anything' });
  if (kind === 'duplicate-row') t.native_candidate!.push({ ...t.native_candidate![0]! });
  if (kind === 'object-key') {
    const r = t.rs_package_file![0]!; r.object_key = 'identity/client.json';
    m.references.find((p) => p.kind === 'package' && p.resultsVersion === r.version_id && p.path === r.path)!.objectKey = 'identity/client.json';
  }
  const sha = await rewrite(w, out.manifestKey, m);
  await expect(verifyNativeExport(deps, { ...req, expectedManifestSha256: sha })).rejects.toMatchObject({ code: expect.stringMatching(/manifest-invalid|foreign-input|export-incomplete/) });
});
it.each(['tamper', 'missing'] as const)('refuses %s retained archive blobs with the original pinned manifest', async (kind) => {
  const w = await setup(), deps = await w.deps(), out = await exportNativeCase(deps, req);
  const key = out.manifestKey.replace('manifest.json', out.manifest.references[0]!.blob);
  if (kind === 'missing') w.bucket.objects.delete(key); else w.bucket.tamper(key, (b) => { b[0] ^= 1; return b; });
  await expect(verifyNativeExport(deps, { ...req, expectedManifestSha256: out.manifestSha256 })).rejects.toMatchObject({ code: kind === 'missing' ? 'export-incomplete' : 'export-corrupt' });
});
it('rechecks exact native operator entitlement after preflight head, before any archive write', async () => {
  const w = await setup(), deps = await w.deps(), head = w.bucket.head.bind(w.bucket); let revoked = false;
  w.bucket.head = async (key) => {
    const result = await head(key);
    if (key.includes('/native-e1/blobs/') && !revoked) { revoked = true; w.db.exec("UPDATE tenant_case_grants SET state = 'revoked', revoked_at = ? WHERE grant_id = 'operator'", '2026-10-25T12:00:00.000Z'); }
    return result;
  };
  await expect(exportNativeCase(deps, req)).rejects.toMatchObject({ code: 'not-found' });
  expect(revoked).toBe(true); expect(w.bucket.puts.some((key) => key.includes('/native-e1/'))).toBe(false);
});
it('brackets custom live policy IO with actual request authority', async () => {
  const w = await setup(), original = w.options.nativeEvidence!.visibility!;
  w.options.nativeEvidence!.visibility = { kind: 'current-policy', async isVisible(q) { const answer = await original.isVisible(q); w.state.revoked = true; return answer; } };
  const deps = await w.deps();
  expect(await deps.nativeEvidence!.visibility.isVisible({ identity: w.identity, caseId: CASE, resultsVersion: w.current.link.candidate.resultsVersion })).toBe(false);
});
it('retains uncertainty on a lost manifest acknowledgement rather than returning invented success', async () => {
  const w = await setup(), d = await w.deps(), put = w.bucket.put.bind(w.bucket);
  w.bucket.put = async (...args) => { if (args[0].endsWith('/native-e1/manifest.json')) w.bucket.ackLoss = true; return put(...args); };
  await expect(exportNativeCase(d, req)).rejects.toMatchObject({ code: 'export-exists' });
  expect(w.bucket.puts.some((key) => key.endsWith('/native-e1/manifest.json'))).toBe(true);
  await expect(exportNativeCase(d, req)).rejects.toMatchObject({ code: 'export-exists' });
});
it('reserves a fresh first-primary session whose first operation is the entire evidence batch', async () => {
  const w = await setup(), deps = await w.deps(), open = w.resources.db.withSession;
  let batches = 0, sessions = 0;
  w.resources.db.withSession = (constraint) => {
    sessions++;
    const db = open(constraint);
    return {
      prepare(sql) {
        const stmt = db.prepare(sql), bind = stmt.bind.bind(stmt);
        stmt.bind = (...args) => {
          const bound = bind(...args);
          bound.first = async () => { throw new Error('primary constraint consumed before the evidence batch'); };
          bound.all = async () => { throw new Error('primary constraint consumed before the evidence batch'); };
          return bound;
        };
        return stmt;
      },
      async batch(statements) { batches++; return db.batch(statements); },
    };
  };
  await exportNativeCase(deps, req);
  expect(sessions).toBe(1); expect(batches).toBe(1);
});
it('the standalone codec enforces all explicit file budgets, not only transport and lineage bounds', async () => {
  const w = await setup(), d = await w.deps(), out = await exportNativeCase(d, req), bytes = encode(canonicalJson(out.manifest)), limits = d.nativeEvidence!.limits;
  const largest = Math.max(...out.manifest.references.map((r) => r.size), out.manifest.userWork!.size);
  for (const policy of [{ ...limits, maxFiles: 1 }, { ...limits, maxFileBytes: 1 }, { ...limits, maxFileBytes: largest, maxTotalBytes: largest }]) {
    await expect(parseNativeManifest(bytes, policy)).rejects.toMatchObject({ code: 'export-too-large' });
  }
});
it('rejects invalid UTF-8, BOM and malformed nested publication before acknowledgement', async () => {
  const w = await setup(), d = await w.deps(), out = await exportNativeCase(d, req), limits = d.nativeEvidence!.limits;
  for (const bytes of [new Uint8Array([0xff]), new Uint8Array([0xef, 0xbb, 0xbf, 123, 125])]) await expect(parseNativeManifest(bytes, limits)).rejects.toMatchObject({ code: 'manifest-invalid' });
  Object.assign(out.manifest.source, { publication: null });
  await expect(parseNativeManifest(encode(canonicalJson(out.manifest)), limits)).rejects.toMatchObject({ code: 'manifest-invalid' });
});
it('strict /2 rejects duplicate JSON keys and unknown top-level keys', async () => {
  const w = await setup(), deps = await w.deps(), out = await exportNativeCase(deps, req), limits = deps.nativeEvidence!.limits;
  const raw = canonicalJson(out.manifest);
  await expect(parseNativeManifest(encode(raw.replace('{', '{"format":"clearcase.recovery-export/2",')), limits)).rejects.toMatchObject({ code: 'manifest-invalid' });
  await expect(parseNativeManifest(encode(canonicalJson({ ...out.manifest, sessionId: 'no-active-session' })), limits)).rejects.toMatchObject({ code: 'manifest-invalid' });
});
