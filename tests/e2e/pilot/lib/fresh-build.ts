// Fresh-build evidence: a run is release evidence only for the build of the commit it reports. The runners (parity
// run.mjs, the e2e runner tests/e2e/pilot/run.mjs, the measure dispatcher) record the build stamp's revision and
// dirtiness (build/clearcase-build.json, written by scripts/pilot/copy-pdfjs.ts: `revision` = git HEAD or the exported
// CLEARCASE_SOURCE_REVISION, `dirty` = tracked files modified at build time), HEAD, and whether tracked files are
// modified now (git status --porcelain --untracked-files=no, as the stamp uses). When the build is not HEAD's or
// either tree is dirty they refuse with exit 2, unless --allow-stale-build (or CLEARCASE_ALLOW_STALE_BUILD=1) is
// given; then the scorecard or summary says `evidence: false` and why.
import { spawnSync } from 'node:child_process';

export const ALLOW_FLAG = '--allow-stale-build';
export const ALLOW_ENV = 'CLEARCASE_ALLOW_STALE_BUILD';

export interface BuildStamp { revision?: string | null; dirty?: boolean; buildId?: string; exported?: boolean }
export interface Freshness {
	/** the revision the build was made from (the stamp's), or the revision under test the caller names */
	buildRevision: string | null;
	/** tracked files were modified when the build was made */
	buildDirty: boolean | null;
	head: string | null;
	/** tracked files are modified now */
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

/** HEAD and the modified tracked files of `repo` (null when it is not a git checkout). */
export function gitState(repo: string): { head: string | null; trackedDirty: boolean | null; dirtyPaths: string[] } {
	const head = git(repo, ['rev-parse', 'HEAD'])?.trim() || null;
	const status = git(repo, ['status', '--porcelain', '--untracked-files=no']);
	const dirtyPaths = status === null ? [] : status.split('\n').filter(Boolean).map((l) => l.slice(3));
	return { head, trackedDirty: status === null ? null : dirtyPaths.length > 0, dirtyPaths };
}

/** Whether `stamp` (or `{revision}` the caller resolved, dirty false) is a fresh build of `repo`'s clean HEAD. */
export function freshness(repo: string, stamp: BuildStamp | null): Freshness {
	const g = gitState(repo);
	const buildRevision = stamp?.revision ?? null;
	const buildDirty = stamp ? !!stamp.dirty : null;
	const reasons: string[] = [];
	if (!stamp) reasons.push('no build stamp');
	else if (!buildRevision) reasons.push('the build stamp names no revision');
	if (!g.head) reasons.push(`${repo} is not a git checkout (HEAD unknown)`);
	if (buildRevision && g.head && buildRevision !== g.head) reasons.push(`the build is of ${short(buildRevision)}, not HEAD ${g.head.slice(0, 12)}`);
	if (buildDirty) reasons.push('the build was made from a tree with modified tracked files');
	if (g.trackedDirty) reasons.push(`tracked files are modified: ${g.dirtyPaths.slice(0, 8).join(', ')}${g.dirtyPaths.length > 8 ? ', …' : ''}`);
	return { buildRevision, buildDirty, head: g.head, trackedDirty: g.trackedDirty, dirtyPaths: g.dirtyPaths, fresh: reasons.length === 0, reasons };
}

/** The override: --allow-stale-build in `argv`, or CLEARCASE_ALLOW_STALE_BUILD=1 in `env`. */
export const allowStale = (argv: readonly string[], env: Record<string, string | undefined> = process.env) => argv.includes(ALLOW_FLAG) || env[ALLOW_ENV] === '1';

/** What a scorecard or summary records: `evidence` is false whenever the build is not fresh. */
export const evidenceRecord = (f: Freshness, allowed: boolean) => ({
	evidence: f.fresh,
	freshBuild: { buildRevision: f.buildRevision, buildDirty: f.buildDirty, head: f.head, trackedDirty: f.trackedDirty, fresh: f.fresh, reasons: f.reasons, allowStaleBuild: allowed },
	...(f.fresh ? {} : { evidenceNote: `NOT release evidence (--allow-stale-build): ${f.reasons.join('; ')}` }),
});

/** One line for the console. */
export const freshLine = (f: Freshness) => `build ${f.buildRevision ? short(f.buildRevision) : 'unknown'}${f.buildDirty ? ' (dirty)' : ''}, HEAD ${f.head?.slice(0, 12) ?? 'unknown'}${f.trackedDirty ? ' (tracked files modified)' : ''}: ${f.fresh ? 'fresh' : `STALE: ${f.reasons.join('; ')}`}`;

/** The refusal message (exit 2) when the build is stale and no override was given. */
export const refusal = (who: string, f: Freshness) => `${who}: refusing a stale build (${f.reasons.join('; ')}). Commit, then run \`bun run --bun build\`, or pass ${ALLOW_FLAG} (${ALLOW_ENV}=1) to run anyway with evidence: false.`;
