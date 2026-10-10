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
// state git cannot establish (say an unreadable index), a directory that is not git's top level (git would answer for
// the checkout around it), tracked files flagged assume-unchanged or skip-worktree, a stamp that does not parse or does
// not say whether its tree was dirty, and an app tree under test (E2E_ROOT, --app-root) other than the repository itself
// are each a refusal reason. git runs without any GIT_* variable, without the fsmonitor hook or the untracked cache, and
// lists untracked files whatever its config says. In the build inputs (BUILD_INPUTS), an untracked file only a local
// ignore rule hides (.git/info/exclude, a global excludes file) and an untracked .gitignore that ignores itself are
// refusal reasons too: only the committed .gitignore files may hide a file there. A file a runner reads by name at run
// time (a register file, a module or suite it finds by listing a folder) must also be a committed review input
// (uncommittedInputs: tracked, unmodified and not hidden as given and resolved, inside its folder, and its bytes HEAD's
// blob), since a committed .gitignore can ignore it without making the tree dirty and a stale index can hide an edit;
// the runners record such a run as not evidence.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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
/**
 * The environment git runs in here: every GIT_* variable removed, so GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
 * GIT_COMMON_DIR or injected config (GIT_CONFIG_*) cannot make git answer for another repository, work tree or index.
 */
export const gitEnv = (env: NodeJS.ProcessEnv = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('GIT_')));

/** git's output, or null and why it failed (its first stderr line). */
const git = (repo: string, args: string[], input?: string): { out: string | null; error: string | null } => {
	const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: gitEnv(), input });
	return r.status === 0 ? { out: r.stdout, error: null } : { out: null, error: (r.error?.message ?? r.stderr ?? '').trim().split('\n')[0] || `exit ${r.status}` };
};

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

/**
 * What the build and the runners read, taken from the code: the app (src, static), every script and test (scripts,
 * tests), the parity register (docs/reference/parity), the docs files the runners read (v5-summary.json: parity and
 * the v5 fixture; view-coverage.json and work-items.json: the registry generator and the pilot suite;
 * audit-dispositions.md: verify:pilot:v5), and every file at the repository root (package.json, bun.lock, the vite,
 * svelte and TypeScript configs, and any config a tool picks up there by name). `:(glob)*` matches root files only.
 */
export const BUILD_INPUTS = ['src', 'scripts', 'tests', 'static', 'docs/reference/parity', 'docs/reference/v5-summary.json', 'docs/plan/view-coverage.json', 'docs/plan/work-items.json', 'docs/reference/audit-dispositions.md', ':(glob)*'];
const INPUT_DIRS = ['src', 'scripts', 'tests', 'static', 'docs/reference/parity'];
/** Every call that reads the index or the work tree skips the fsmonitor hook and the untracked cache, which can hide changes. */
const FRESH_READ = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];

export interface GitState {
	/** git's top level for `repo` (realpath), or null when `repo` is in no git checkout */
	top: string | null;
	head: string | null;
	trackedDirty: boolean | null;
	dirtyPaths: string[];
	/** tracked files git is told not to look at (assume-unchanged or skip-worktree): their changes are invisible */
	hiddenPaths: string[];
	/** untracked files in the build inputs that only a local ignore rule (.git/info/exclude, a global excludes file) hides */
	locallyIgnored: string[];
	/** untracked .gitignore files in the build input folders that ignore themselves (and so hide their folder) */
	selfIgnoring: string[];
	headError: string | null;
	statusError: string | null;
	/** set when git's top level is another directory: git would answer for that checkout, not for `repo` */
	checkoutError: string | null;
}

/**
 * HEAD and the modified or untracked (not ignored) files of `repo`, asked of git about `repo` itself. The answer is
 * refused (checkoutError) when git's top level is not `repo` (a copy inside another checkout, a nested repository git
 * does not accept, so it walks up to the parent). Untracked files are listed whatever status.showUntrackedFiles says,
 * and tracked files flagged assume-unchanged or skip-worktree are listed in hiddenPaths. head or trackedDirty is null
 * when git cannot establish it (not a git checkout, an unreadable index), with git's reason in headError or statusError.
 */
export function gitState(repo: string): GitState {
	const t = git(repo, ['rev-parse', '--show-toplevel']);
	const top = t.out?.trim() ? real(t.out.trim()) : null;
	if (top !== null && top !== real(repo)) {
		const why = `${real(repo)} is not the top level of its git checkout: git answers for ${top}`;
		return { top, head: null, trackedDirty: null, dirtyPaths: [], hiddenPaths: [], locallyIgnored: [], selfIgnoring: [], headError: why, statusError: why, checkoutError: why };
	}
	const h = git(repo, ['rev-parse', '--verify', 'HEAD']);
	const head = h.out?.trim() || null;
	const st = git(repo, [...FRESH_READ, '-c', 'status.showUntrackedFiles=normal', 'status', '--porcelain', '--untracked-files=normal']);
	const dirtyPaths = st.out === null ? [] : st.out.split('\n').filter(Boolean).map((l) => l.slice(3));
	// `ls-files -v` tags an assume-unchanged entry with a lower-case letter and a skip-worktree entry with S
	const lf = git(repo, [...FRESH_READ, 'ls-files', '-v']);
	const hiddenPaths = lf.out === null ? [] : lf.out.split('\n').filter((l) => /^([a-z]|S) /.test(l)).map((l) => l.slice(2));
	// untracked input files the committed .gitignore files do not ignore, minus those the standard rules (which add
	// .git/info/exclude and the global excludes file) do not ignore: what only a local rule hides
	const lines = (r: { out: string | null }) => (r.out ?? '').split('\n').filter(Boolean);
	const perDir = git(repo, [...FRESH_READ, 'ls-files', '-o', '--exclude-per-directory=.gitignore', '--', ...BUILD_INPUTS]);
	const standard = git(repo, [...FRESH_READ, 'ls-files', '-o', '--exclude-standard', '--', ...BUILD_INPUTS]);
	const seen = new Set(lines(standard));
	const locallyIgnored = lines(perDir).filter((p) => !seen.has(p));
	const selfIg = git(repo, [...FRESH_READ, 'ls-files', '-o', '-i', '--exclude-standard', '--', ...INPUT_DIRS.map((d) => `:(glob)${d}/**/.gitignore`)]);
	const selfIgnoring = lines(selfIg);
	const calls = [st, lf, perDir, standard, selfIg];
	const known = calls.every((c) => c.out !== null);
	return { top, head, trackedDirty: known ? dirtyPaths.length > 0 : null, dirtyPaths, hiddenPaths, locallyIgnored, selfIgnoring, headError: head ? null : h.error ?? 'no output', statusError: calls.find((c) => c.error)?.error ?? null, checkoutError: null };
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
	if (g.checkoutError) reasons.push(g.checkoutError);
	else {
		if (!g.head) reasons.push(`${repo} is not a git checkout (HEAD unknown: ${g.headError})`);
		if (g.trackedDirty === null) reasons.push(`the working-tree state of ${repo} is unknown (git status failed: ${g.statusError})`);
	}
	if (buildRevision && g.head && buildRevision !== g.head) reasons.push(`the build is of ${short(buildRevision)}, not HEAD ${g.head.slice(0, 12)}`);
	if (buildDirty) reasons.push('the build was made from a tree with modified or untracked files');
	else if (stamp && !stamp.unreadable && buildDirty === null) reasons.push('the build stamp does not say whether its tree had modified or untracked files (git could not tell at build time)');
	if (g.trackedDirty) reasons.push(`files are modified or untracked: ${g.dirtyPaths.slice(0, 8).join(', ')}${g.dirtyPaths.length > 8 ? ', …' : ''}`);
	const list = (ps: string[]) => `${ps.slice(0, 8).join(', ')}${ps.length > 8 ? ', …' : ''}`;
	if (g.locallyIgnored.length) reasons.push(`untracked files in the build inputs are hidden only by a local ignore rule (.git/info/exclude or a global excludes file): ${list(g.locallyIgnored)}`);
	if (g.selfIgnoring.length) reasons.push(`untracked .gitignore files in the build inputs ignore themselves and hide their folder: ${list(g.selfIgnoring)}`);
	if (g.hiddenPaths.length) reasons.push(`git is told not to look at tracked files (assume-unchanged or skip-worktree), so their changes are invisible: ${g.hiddenPaths.slice(0, 8).join(', ')}${g.hiddenPaths.length > 8 ? ', …' : ''}`);
	const own = (dir: string) => !!isolated && real(dir) === real(isolated.buildDir) && !!stamp?.exported && stamp.revision === isolated.revision;
	if (buildDir && real(buildDir) !== real(join(repo, 'build')) && !own(buildDir)) reasons.push(`the build is not ${join(real(repo), 'build')} (it is ${real(buildDir)})`);
	if (appRoot && real(appRoot) !== real(repo)) reasons.push(`the app tree under test is ${real(appRoot)}, not ${real(repo)} (its server entry, suites and routes would be unverified)`);
	return { buildRevision, buildDirty, head: g.head, trackedDirty: g.trackedDirty, dirtyPaths: g.dirtyPaths, fresh: reasons.length === 0, reasons };
}

/** git's blob id for `bytes`: the hash of `blob <length>\0<bytes>`, no filters applied, in the given object format. */
export const gitBlobId = (bytes: Uint8Array, format: 'sha1' | 'sha256' = 'sha1') => createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** What a runner read by name and the bytes it read, by the path it read them from (see uncommittedInputs). */
export type ReadBytes = Readonly<Record<string, Uint8Array>>;

/**
 * The files among `paths` that are not committed review inputs of `repo`, each as `<path> (<why>; ...)`. A file a
 * runner reads by name at run time (a register file, a module or suite it finds by listing a folder) counts only when:
 * - the path as given (only the checkout's own path resolved) and its realpath both lie in `repo` and, with `within`
 *   (a folder relative to `repo`), inside that folder;
 * - git's index tracks both, git status shows no change to either (staged or not), and neither is flagged
 *   assume-unchanged or skip-worktree;
 * - the bytes the runner read (`read`, by path; a file not in it is read now) are HEAD's blob at the path as given:
 *   hashed as git hashes a blob, without filters, and compared with HEAD's tree, so neither a stale or poisoned index
 *   (a clean filter, a restored mtime) nor a symlink can stand in for the committed contents.
 * Freshness does not cover this: a file a committed .gitignore ignores (say under .local/) leaves git status clean.
 * When git cannot answer, or `repo` is not its top level, the why is `unknown (...)`. git runs as gitState runs it
 * (gitEnv, FRESH_READ). Paths are shown relative to `repo` when inside.
 */
export function uncommittedInputs(repo: string, paths: readonly string[], { within, read = {} }: { within?: string; read?: ReadBytes } = {}): string[] {
	const top = real(repo);
	const inside = (x: string) => x !== '' && x !== '..' && !x.startsWith(`..${sep}`) && !isAbsolute(x);
	const posix = (x: string) => x.split(sep).join('/');
	const given = (p: string) => { for (const r of new Set([resolve(repo), top])) { const x = relative(r, resolve(p)); if (inside(x)) return posix(x); } return null; };
	const resolved = (p: string) => { const x = relative(top, real(p)); return inside(x) ? posix(x) : null; };
	const under = (f: string) => !within || f.startsWith(`${within}/`);
	const items = [...new Set(paths)].map((p) => ({ p, g: given(p), r: resolved(p) }));
	const rels = [...new Set(items.flatMap((i) => [i.g, i.r]).filter((x): x is string => x !== null))];
	const state = new Map<string, string>();
	const head = new Map<string, string>();
	let error: string | null = null;
	if (rels.length) {
		const specs = rels.map((f) => `:(literal)${f}`);
		const at = git(repo, ['rev-parse', '--show-toplevel']);
		const ls = git(repo, [...FRESH_READ, 'ls-files', '-v', '-z', '--', ...specs]);
		const ign = git(repo, [...FRESH_READ, 'ls-files', '-o', '-i', '--exclude-standard', '-z', '--', ...specs]);
		const st = git(repo, [...FRESH_READ, 'status', '--porcelain', '-z', '--untracked-files=no', '--', ...specs]);
		const objs = git(repo, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], rels.map((f) => `HEAD:${f}`).join('\n') + '\n');
		error = at.error ?? ls.error ?? ign.error ?? st.error ?? objs.error ?? (real(at.out!.trim()) === top ? null : `${top} is not the top level of its git checkout`) ?? (rels.some((f) => f.includes('\n')) ? 'a path holds a newline' : null);
		if (!error) {
			const tags = new Map(ls.out!.split('\0').filter(Boolean).map((l) => [l.slice(2), l[0]!]));
			const ignored = new Set(ign.out!.split('\0').filter(Boolean));
			const changed = new Set<string>();
			const recs = st.out!.split('\0');
			// porcelain -z: `XY path`, and a rename or copy is followed by its source path
			for (let i = 0; i < recs.length; i++) if (recs[i]) { changed.add(recs[i]!.slice(3)); if (/^[RC]/.test(recs[i]!)) i++; }
			for (const f of rels) {
				const tag = tags.get(f);
				const why = tag === undefined ? (ignored.has(f) ? 'ignored' : 'untracked') : /^([a-z]|S)$/.test(tag) ? 'hidden from git (assume-unchanged or skip-worktree)' : changed.has(f) ? 'modified' : null;
				if (why) state.set(f, why);
			}
			// one `<oid> <type>` line per path, or `HEAD:<path> missing`
			objs.out!.split('\n').slice(0, rels.length).forEach((l, i) => { const [oid, type] = l.split(' '); if (type === 'blob' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(oid!)) head.set(rels[i]!, oid!); });
		}
	}
	const out: string[] = [];
	for (const { p, g, r } of items) {
		const why: string[] = [];
		if (g === null) why.push(`outside the checkout ${top}`);
		else {
			if (!under(g)) why.push(`outside ${within}/`);
			if (error) why.push(`unknown: ${error}`);
			else {
				if (state.has(g)) why.push(state.get(g)!);
				if (r === null) why.push(`resolves outside the checkout, to ${real(p)}`);
				else if (r !== g) why.push(`resolves ${under(r) ? '' : `outside ${within}/, `}to ${r}${state.has(r) ? `, which is ${state.get(r)}` : ''}`);
				if (!state.has(g)) {
					const id = head.get(g);
					let bytes: Uint8Array | null = read[p] ?? null;
					if (!bytes) try { bytes = readFileSync(p); } catch { bytes = null; }
					if (!id) why.push('not in HEAD');
					else if (!bytes) why.push('unreadable');
					else if (gitBlobId(bytes, id.length === 64 ? 'sha256' : 'sha1') !== id) why.push("its bytes are not HEAD's");
				}
			}
		}
		if (why.length) out.push(`${g ?? real(p)} (${why.join('; ')})`);
	}
	return out;
}

/**
 * One reason a run is not release evidence when some of `paths` are not committed review inputs (uncommittedInputs,
 * with its `within` and `read`), else none.
 */
export const notCommitted = (what: string, repo: string, paths: readonly string[], opts: { within?: string; read?: ReadBytes } = {}) => {
	const found = uncommittedInputs(repo, paths, opts);
	return found.length ? [`${what} that the reviewed commit does not hold: ${found.join(', ')}`] : [];
};

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
