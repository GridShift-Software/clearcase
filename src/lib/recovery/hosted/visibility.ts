import type { CaseId, ResultsVersion } from '../../server/runtime/contracts.ts';
import { recheck } from './authority.ts';
import { fail } from './bytes.ts';
import type { ExportManifest, RecoveryDeps, VersionVisibilityPort } from './types.ts';

type VisibilityDeps = Pick<RecoveryDeps, 'profile' | 'visibility' | 'identity'>;
/** No fallback to a historical publication, a version listing, or a case grant when live policy is absent. */
export function requireVisibility(deps: VisibilityDeps): VersionVisibilityPort {
  const port = deps.visibility;
  if (!port || typeof port.isVisible !== 'function' ||
    (port.kind !== 'current-policy' && port.kind !== 'test-standin') ||
    (deps.profile === 'production' && port.kind !== 'current-policy')) throw fail('recovery-unavailable', true);
  return port;
}

export async function requireVisible(deps: VisibilityDeps, caseId: CaseId, resultsVersion: ResultsVersion) {
  // Malformed identities must not disappear from the set that is checked against current policy.
  if (typeof resultsVersion !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(resultsVersion)) throw fail('manifest-invalid');
  if (await requireVisibility(deps).isVisible({ identity: deps.identity, caseId, resultsVersion }) !== true) throw fail('not-found');
}

/** Include metadata-only identities too: neither an active pointer nor a preview can smuggle in an unlisted version. */
export async function checkVisibility(deps: VisibilityDeps, manifest: ExportManifest) {
  requireVisibility(deps);
  if (manifest.resultsVersions.some((v) => v.version.case_id !== manifest.caseId)) throw fail('foreign-input');
  const versions = new Set<ResultsVersion>([
    ...manifest.resultsVersions.map((v) => v.version.id), ...manifest.previews.map((p) => p.resultsVersion),
  ]);
  if (!manifest.source || !manifest.source.publication) throw fail('manifest-invalid');
  const publication = manifest.source.publication;
  if (publication.kind === 'published') versions.add(publication.resultsVersion);
  else if (publication.kind !== 'none' && publication.kind !== 'withdrawn') throw fail('manifest-invalid');
  if (manifest.source.activeVersion !== null) versions.add(manifest.source.activeVersion);
  for (const version of versions) await requireVisible(deps, manifest.caseId, version);
}

/** Call after the last awaited read/target/audit work, and again before a mutation: grants and policy are never cached. */
export async function recheckExportAuthority(deps: VisibilityDeps, manifest: ExportManifest, scopes: Parameters<typeof recheck>[1]) {
  await checkVisibility(deps, manifest);
  await recheck(deps, scopes);
}
