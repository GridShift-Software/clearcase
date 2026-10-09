// Fresh-build evidence: a run is release evidence only for the build of the commit it reports. The runners (parity
// run.mjs, the e2e runner tests/e2e/pilot/run.mjs, the measure dispatcher, verify:pilot:v5) record the build stamp's
// revision and dirtiness (build/clearcase-build.json, written by scripts/pilot/copy-pdfjs.ts: `revision` = git HEAD,
// or the exported CLEARCASE_SOURCE_REVISION, or null for a copy that is not its own git checkout; `dirty` = files
// modified or untracked (not ignored) at build time), HEAD, and whether files are modified or untracked now (the
// default git status, which respects .gitignore, as the stamp uses). A build directory other than <repo>/build is
// stale too, unless it is an isolated build this runner made itself (isolatedBuild: its stamp is `exported` with the
// revision the runner exported). When the build is stale they refuse with exit 2, unless --allow-stale-build is
// passed (the flag only; no environment form, so a stray shell export cannot switch the guard off); then the run
// records `evidence: false` and its final status line says NOT EVIDENCE.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ALLOW_FLAG = '--allow-stale-build';

export interface BuildStamp { revision?: string | null; dirty?: boolean; buildId?: string; exported?: boolean }
export interface Freshness {
	/** the revision the build was made from (the stamp's), or the revision under test the caller names */
	buildRevision: string | null;
	/** tracked files were modified when the build was made */
	buildDirty: boolean | null;
	head: string | null;
	/** files are modified or untracked (not ignored) now */
	trackedDirty: boolean | null;
	dirtyPaths: string[];
	fresh: boolean;
	reasons: string[];
}

/** A commit id shortened to 12 characters; any other revision label (a mutant's, say) in full. */
const short = (r: string) => (/^[0-9a-f]{40}$/.test(r) ? r.slice(0, 12) : r);
const git = (repo: string, args: string[]) => {
	const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
	return r.status === 0 ? r.stdout : null;
};

/** HEAD and the modified or untracked (not ignored) files of `repo` (null when it is not a git checkout). */
export function gitState(repo: string): { head: string | null; trackedDirty: boolean | null; dirtyPaths: string[] } {
	const head = git(repo, ['rev-parse', 'HEAD'])?.trim() || null;
	const status = git(repo, ['status', '--porcelain']);
	const dirtyPaths = status === null ? [] : status.split('\n').filter(Boolean).map((l) => l.slice(3));
	return { head, trackedDirty: status === null ? null : dirtyPaths.length > 0, dirtyPaths };
}

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** An isolated build this runner made (isolatedBuild's result): the revision it exported and where it built it. */
export interface IsolatedBuild { revision: string; buildDir: string }

/**
 * Whether `stamp` (or `{revision}` the caller resolved, dirty false) is a fresh build of `repo`'s clean HEAD. With
 * `buildDir`, the build must also be `<repo>/build`, unless `isolated` names that directory and the stamp is the
 * exported one of `isolated.revision`.
 */
export function freshness(repo: string, stamp: BuildStamp | null, { buildDir, isolated }: { buildDir?: string; isolated?: IsolatedBuild | null } = {}): Freshness {
	const g = gitState(repo);
	const buildRevision = stamp?.revision ?? null;
	const buildDirty = stamp ? !!stamp.dirty : null;
	const reasons: string[] = [];
	if (!stamp) reasons.push('no build stamp');
	else if (!buildRevision) reasons.push('the build stamp names no revision');
	if (!g.head) reasons.push(`${repo} is not a git checkout (HEAD unknown)`);
	if (buildRevision && g.head && buildRevision !== g.head) reasons.push(`the build is of ${short(buildRevision)}, not HEAD ${g.head.slice(0, 12)}`);
	if (buildDirty) reasons.push('the build was made from a tree with modified or untracked files');
	if (g.trackedDirty) reasons.push(`files are modified or untracked: ${g.dirtyPaths.slice(0, 8).join(', ')}${g.dirtyPaths.length > 8 ? ', …' : ''}`);
	if (buildDir && real(buildDir) !== real(join(repo, 'build'))) {
		const own = !!isolated && real(buildDir) === real(isolated.buildDir) && !!stamp?.exported && stamp.revision === isolated.revision;
		if (!own) reasons.push(`the build is not ${join(real(repo), 'build')} (it is ${real(buildDir)})`);
	}
	return { buildRevision, buildDirty, head: g.head, trackedDirty: g.trackedDirty, dirtyPaths: g.dirtyPaths, fresh: reasons.length === 0, reasons };
}

/** The override: --allow-stale-build in `argv` (there is no environment form). */
export const allowStale = (argv: readonly string[]) => argv.includes(ALLOW_FLAG);

/** What a scorecard or summary records: `evidence` is false whenever the build is not fresh or the override is on. */
export const evidenceRecord = (f: Freshness, allowed: boolean) => ({
	evidence: f.fresh && !allowed,
	freshBuild: { buildRevision: f.buildRevision, buildDirty: f.buildDirty, head: f.head, trackedDirty: f.trackedDirty, fresh: f.fresh, reasons: f.reasons, allowStaleBuild: allowed },
	...(f.fresh && !allowed ? {} : { evidenceNote: `NOT release evidence (${allowed ? '--allow-stale-build' : 'stale build'}): ${f.reasons.join('; ') || 'the override was passed'}` }),
});

/** The final status line's suffix: empty for evidence, else NOT EVIDENCE and why. */
export const evidenceSuffix = (rec: { evidence: boolean; evidenceNote?: string }) => (rec.evidence ? '' : ` — NOT EVIDENCE (${rec.evidenceNote})`);

/** One line for the console. */
export const freshLine = (f: Freshness) => `build ${f.buildRevision ? short(f.buildRevision) : 'unknown'}${f.buildDirty ? ' (dirty)' : ''}, HEAD ${f.head?.slice(0, 12) ?? 'unknown'}${f.trackedDirty ? ' (files modified or untracked)' : ''}: ${f.fresh ? 'fresh' : `STALE: ${f.reasons.join('; ')}`}`;

/** The refusal message (exit 2) when the build is stale and no override was given: what to do next. */
export const refusal = (who: string, f: Freshness) => `${who}: stale build (${f.reasons.join('; ')}): git add and commit every change (move scratch files to .local/), then run \`bun run --bun build\` in the repository itself, then rerun (or pass ${ALLOW_FLAG} for a non-evidence run)`;
