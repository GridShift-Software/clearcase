import { inputRevisionId, resultsVersionOf, sha256Hex } from './hash.ts';
import { FORMAT, FORMAT_VERSION, Manifest } from './schema.ts';
import { decodeUtf8Strict, isObject, parseStrictJson } from './strict-json.ts';
import Value from 'typebox/value';
import type { CandidateIdentity } from './candidate.ts';
import type { HeldFile } from './source.ts';

export type StoredFiles = ReadonlyMap<string, Uint8Array> | Readonly<Record<string, Uint8Array>> | Iterable<readonly [string, Uint8Array]>;

export interface BytesVerdict { ok: boolean; problems: string[] }

function toMap(files: StoredFiles): Map<string, Uint8Array> {
  if (files instanceof Map) return new Map(files);
  if (Symbol.iterator in Object(files)) return new Map(files as Iterable<readonly [string, Uint8Array]>);
  return new Map(Object.entries(files as Record<string, Uint8Array>));
}

/**
 * `held` names files whose bytes were checked elsewhere (a stepped import's previews): each is judged on its recorded size and SHA-256
 * as a file of the same bytes would be, and a held path the manifest does not list is as unexpected as an extra file.
 */
export function verifyCandidateBytes(storedFiles: StoredFiles, expected: CandidateIdentity, held?: ReadonlyMap<string, HeldFile>): BytesVerdict {
  const problems: string[] = [];
  const files = toMap(storedFiles);
  const mBytes = files.get('manifest.json');
  if (!mBytes) return { ok: false, problems: ['manifest.json is not stored'] };
  if (sha256Hex(mBytes) !== expected.manifestSha256) problems.push('manifest.json bytes do not match manifestSha256');
  let m: unknown;
  try { m = parseStrictJson(decodeUtf8Strict(mBytes)); } catch { return { ok: false, problems: [...problems, 'manifest.json is not strict JSON'] }; }
  if (!isObject(m) || m.format !== FORMAT || m.formatVersion !== FORMAT_VERSION || !Value.Check(Manifest, m)) return { ok: false, problems: [...problems, 'manifest.json is not a supported manifest'] };
  const manifest = m as unknown as Manifest;
  const listed = new Set(['manifest.json', ...manifest.files.map((f) => f.path)]);
  for (const p of files.keys()) if (!listed.has(p)) problems.push(`unexpected stored file ${p}`);
  for (const p of held?.keys() ?? []) if (!listed.has(p) || files.has(p)) problems.push(`unexpected stored file ${p}`);
  for (const f of manifest.files) {
    const b = files.get(f.path), h = b ? undefined : held?.get(f.path);
    if (!b && !h) { problems.push(`listed file ${f.path} is not stored`); continue; }
    const size = b ? b.byteLength : h!.size;
    if (size !== f.size) problems.push(`${f.path}: size ${size} differs from ${f.size}`);
    else if ((b ? sha256Hex(b) : h!.sha256) !== f.sha256) problems.push(`${f.path}: sha256 differs`);
  }
  if (inputRevisionId(manifest.inputRevision.sources) !== manifest.inputRevision.id) problems.push('inputRevision.id does not match its sources');
  const rv = resultsVersionOf({ formatVersion: manifest.formatVersion, caseId: manifest.case.id, inputRevisionId: manifest.inputRevision.id, files: manifest.files });
  if (rv !== manifest.resultsVersion) problems.push('recomputed resultsVersion differs from the manifest');
  if (rv !== expected.resultsVersion) problems.push('recomputed resultsVersion differs from the expected identity');
  return { ok: problems.length === 0, problems };
}
