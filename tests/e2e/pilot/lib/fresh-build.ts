// Fresh-build evidence: a run is release evidence only for the build of the commit it reports. The runners (parity
// run.mjs, the e2e runner tests/e2e/pilot/run.mjs, the measure dispatcher, verify:pilot:v5) record the build stamp's
// revision and dirtiness (build/clearcase-build.json, written by scripts/pilot/copy-pdfjs.ts: `revision` = git HEAD,
// or the exported CLEARCASE_SOURCE_REVISION, or null for a copy that is not its own git checkout; `dirty` = files
// modified or untracked (not ignored) at build time), HEAD, and whether files are modified or untracked now (the
// default git status, which respects .gitignore, as the stamp uses). A build directory other than <repo>/build is
// stale too, unless it is an isolated build this runner made itself (isolatedBuild: its stamp is `exported` with the
// revision the runner exported). When the build is stale they refuse with exit 2, unless --allow-stale-build is
// passed (the flag only; no environment form, so a stray shell export cannot switch the guard off); then the run
// records `evidence: false` and its final status line says NOT EVIDENCE. The guard fails closed: a HEAD or working-tree
// state git cannot establish (say an unreadable index), a stamp that does not parse or does not say whether its tree was
// dirty, and an app tree under test (E2E_ROOT, --app-root) other than the repository itself are each a refusal reason.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ALLOW_FLAG = '--allow-stale-build';

export interface BuildStamp { revision?: string | null; dirty?: boolean | null; buildId?: string; exported?: boolean; unreadable?: string }
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
/** git's output, or null and why it failed (its first stderr line). */
const git = (repo: string, args: string[]): { out: string | null; error: string | null } => {
	const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
	return r.status === 0 ? { out: r.stdout, error: null } : { out: null, error: (r.error?.message ?? r.stderr ?? '').trim().split('\n')[0] || `exit ${r.status}` };
};

/**
 * HEAD and the modified or untracked (not ignored) files of `repo`; head or trackedDirty is null when git cannot
 * establish it (not a git checkout, an unreadable index), with git's reason in headError or statusError.
 */
export function gitState(repo: string): { head: string | null; trackedDirty: boolean | null; dirtyPaths: string[]; headError: string | null; statusError: string | null } {
	const h = git(repo, ['rev-parse', '--verify', 'HEAD']);
	const head = h.out?.trim() || null;
	const st = git(repo, ['status', '--porcelain']);
	const dirtyPaths = st.out === null ? [] : st.out.split('\n').filter(Boolean).map((l) => l.slice(3));
	return { head, trackedDirty: st.out === null ? null : dirtyPaths.length > 0, dirtyPaths, headError: head ? null : h.error ?? 'no output', statusError: st.error };
}

/** The build stamp in `buildDir`: null when there is none, `{ unreadable }` (never fresh) when it does not parse. */
export function readStamp(buildDir: string): BuildStamp | null {
	const f = join(buildDir, 'clearcase-build.json');
	if (!existsSync(f)) return null;
	try {
		const s = JSON.parse(readFileSync(f, 'utf8'));
		return s && typeof s === 'object' && !Array.isArray(s) ? s : { revision: null, dirty: null, unreadable: `${f} is not a JSON object` };
	} catch (e) { return { revision: null, dirty: null, unreadable: `${f}: ${(e as Error).message}` }; }
}

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** An isolated build this runner made (isolatedBuild's result): the revision it exported and where it built it. */
export interface IsolatedBuild { revision: string; buildDir: string }

/**
 * Whether `stamp` (or `{revision, dirty: false}` the caller resolved) is a fresh build of `repo`'s clean HEAD. With
 * `buildDir`, the build must also be `<repo>/build`, unless `isolated` names that directory and the stamp is the
 * exported one of `isolated.revision`. With `appRoot` (the tree whose server entry, suites and routes the run uses:
 * E2E_ROOT, --app-root), that tree must be `repo` itself (a runner's own isolated build passes no appRoot).
 */
export function freshness(repo: string, stamp: BuildStamp | null, { buildDir, isolated, appRoot }: { buildDir?: string; isolated?: IsolatedBuild | null; appRoot?: string } = {}): Freshness {
	const g = gitState(repo);
	const buildRevision = stamp?.revision ?? null;
	const buildDirty = stamp ? (typeof stamp.dirty === 'boolean' ? stamp.dirty : null) : null;
	const reasons: string[] = [];
	if (!stamp) reasons.push('no build stamp');
	else if (stamp.unreadable) reasons.push(`the build stamp is unreadable (${stamp.unreadable})`);
	else if (!buildRevision) reasons.push('the build stamp names no revision');
	if (!g.head) reasons.push(`${repo} is not a git checkout (HEAD unknown: ${g.headError})`);
	if (g.trackedDirty === null) reasons.push(`the working-tree state of ${repo} is unknown (git status failed: ${g.statusError})`);
	if (buildRevision && g.head && buildRevision !== g.head) reasons.push(`the build is of ${short(buildRevision)}, not HEAD ${g.head.slice(0, 12)}`);
	if (buildDirty) reasons.push('the build was made from a tree with modified or untracked files');
	else if (stamp && !stamp.unreadable && buildDirty === null) reasons.push('the build stamp does not say whether its tree had modified or untracked files (git could not tell at build time)');
	if (g.trackedDirty) reasons.push(`files are modified or untracked: ${g.dirtyPaths.slice(0, 8).join(', ')}${g.dirtyPaths.length > 8 ? ', …' : ''}`);
	const own = (dir: string) => !!isolated && real(dir) === real(isolated.buildDir) && !!stamp?.exported && stamp.revision === isolated.revision;
	if (buildDir && real(buildDir) !== real(join(repo, 'build')) && !own(buildDir)) reasons.push(`the build is not ${join(real(repo), 'build')} (it is ${real(buildDir)})`);
	if (appRoot && real(appRoot) !== real(repo)) reasons.push(`the app tree under test is ${real(appRoot)}, not ${real(repo)} (its server entry, suites and routes would be unverified)`);
	return { buildRevision, buildDirty, head: g.head, trackedDirty: g.trackedDirty, dirtyPaths: g.dirtyPaths, fresh: reasons.length === 0, reasons };
}

/** The override: --allow-stale-build in `argv` (there is no environment form). */
export const allowStale = (argv: readonly string[]) => argv.includes(ALLOW_FLAG);

/**
 * What a scorecard or summary records: `evidence` is false whenever the build is not fresh, the override is on, or the
 * run names another reason it proves nothing about the committed tree (`other`, say a register outside the repository's).
 */
export const evidenceRecord = (f: Freshness, allowed: boolean, other: readonly string[] = []) => {
	const stale = !f.fresh || allowed;
	const note = stale ? [`NOT release evidence (${allowed ? '--allow-stale-build' : 'stale build'}): ${f.reasons.join('; ') || 'the override was passed'}`, ...other].join('; ') : `NOT release evidence: ${other.join('; ')}`;
	return {
		evidence: !stale && other.length === 0,
		freshBuild: { buildRevision: f.buildRevision, buildDirty: f.buildDirty, head: f.head, trackedDirty: f.trackedDirty, fresh: f.fresh, reasons: f.reasons, allowStaleBuild: allowed },
		...(!stale && other.length === 0 ? {} : { evidenceNote: note }),
	};
};

/** The final status line's suffix: empty for evidence, else NOT EVIDENCE and why. */
export const evidenceSuffix = (rec: { evidence: boolean; evidenceNote?: string }) => (rec.evidence ? '' : ` — NOT EVIDENCE (${rec.evidenceNote})`);

/** One line for the console. */
export const freshLine = (f: Freshness) => `build ${f.buildRevision ? short(f.buildRevision) : 'unknown'}${f.buildDirty ? ' (dirty)' : ''}, HEAD ${f.head?.slice(0, 12) ?? 'unknown'}${f.trackedDirty ? ' (files modified or untracked)' : ''}: ${f.fresh ? 'fresh' : `STALE: ${f.reasons.join('; ')}`}`;

/** The refusal message (exit 2) when the build is stale and no override was given: what to do next. */
export const refusal = (who: string, f: Freshness) => `${who}: stale build (${f.reasons.join('; ')}): git add and commit every change (move scratch files to .local/), then run \`bun run --bun build\` in the repository itself, then rerun (or pass ${ALLOW_FLAG} for a non-evidence run)`;
