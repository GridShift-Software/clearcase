import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.ts';
import { FORMAT, type InputSource, type ManifestFile } from './schema.ts';

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** The package-file asset key of a literal case-folder path (refs.ts PATH_KEY_PATTERN). */
export const pathAssetKey = (path: string): string => 'P-' + sha256Hex(path).slice(0, 16);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** inputRevision.id = 'sha256:' + sha256(compactJcs(sorted [{role, sha256, size}])). Names are provenance only. */
export function inputRevisionId(sources: readonly Pick<InputSource, 'role' | 'sha256' | 'size'>[]): string {
  const s = sources.map(({ role, sha256, size }) => ({ role, sha256, size }))
    .sort((a, b) => cmp(a.role, b.role) || cmp(a.sha256, b.sha256) || a.size - b.size);
  return 'sha256:' + sha256Hex(canonicalJson(s));
}

export interface IdentityInput {
  formatVersion: number;
  caseId: string;
  inputRevisionId: string;
  files: readonly Pick<ManifestFile, 'path' | 'role' | 'key' | 'kind' | 'sha256' | 'size'>[];
}

/**
 * resultsVersion = 'sha256:' + sha256(compactJcs({format, formatVersion, caseId, inputRevisionId,
 * files: [{path, role, key, kind, sha256, size}] sorted by path, absent optional fields omitted})).
 * Case label, created, producer and parent are excluded; manifestSha256 pins them separately.
 */
export function resultsVersionOf(m: IdentityInput): string {
  const files = m.files
    .map((f) => ({ path: f.path, role: f.role, ...(f.key !== undefined && { key: f.key }), ...(f.kind !== undefined && { kind: f.kind }), sha256: f.sha256, size: f.size }))
    .sort((a, b) => cmp(a.path, b.path));
  return 'sha256:' + sha256Hex(canonicalJson({ format: FORMAT, formatVersion: m.formatVersion, caseId: m.caseId, inputRevisionId: m.inputRevisionId, files }));
}
