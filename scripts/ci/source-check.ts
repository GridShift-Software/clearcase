// Checks of the committed sources that tsc and svelte-check never see: JavaScript syntax and relative imports in the
// .mjs/.js files (tsconfig has allowJs: false, and the e2e suites, gate and parity runner are plain .mjs that CI never
// runs), bash syntax of the shell scripts, Python syntax, and the CI workflows and composite actions (every action,
// reusable workflow and image pinned to a full commit SHA or image digest, every script a step runs by path
// executable). It reads only tracked files (`git ls-files` from the working
// directory's repository) and changes nothing.
//
// Usage: bun scripts/ci/source-check.ts [--json FILE]
// Each problem is one line, `path:line:col: error [rule] message`, then a summary line with the counts per rule and
// the command that reproduces it. Exit 0 when every rule ran over at least one file and found nothing, 1 on a problem,
// 2 when the check itself cannot run (not a Git checkout, bash or python3 missing, a rule with no files to check).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
// @ts-expect-error plain .mjs script, no declarations
import { gitEnv } from '../browser-lock.mjs';

/** The two Bun APIs this script uses; the project has no @types/bun. */
declare const Bun: {
	Transpiler: new (options: { loader: 'js' }) => { scan(code: string): { imports: { path: string; kind: string }[] } };
	YAML: { parse(text: string): unknown };
};

const RULES = ['js-syntax', 'js-import', 'sh-syntax', 'py-syntax', 'workflow-pin', 'workflow-exec'] as const;
type Rule = (typeof RULES)[number];
type Problem = { rule: Rule; file: string; line: number; col: number; message: string };
type Tracked = { file: string; mode: string };

class SetupError extends Error {}

/** Import targets that are not tracked because the build puts them next to the importer. */
const BUILT: Record<string, string> = {
	'src/lib/local-case/viewer/pdf.min.mjs': 'scripts/pilot/copy-pdfjs.ts copies it from pdfjs-dist into build/pdfjs/ beside viewer.mjs',
};

function git(args: string[]): string {
	const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20, env: gitEnv() });
	if (r.error || r.status !== 0) throw new SetupError(`git ${args.join(' ')} failed: ${r.error?.message ?? r.stderr.trim()}`);
	return r.stdout;
}

/** 1-based line and column of the first occurrence of `needle` in `text`, or 1:1. */
function locate(text: string, needle: string): { line: number; col: number } {
	const at = text.indexOf(needle);
	if (at < 0) return { line: 1, col: 1 };
	const before = text.slice(0, at).split('\n');
	return { line: before.length, col: before.at(-1)!.length + 1 };
}

function isParseError(e: unknown): e is { errors: { message: string; position: { line: number; column: number } | null }[] } {
	return typeof e === 'object' && e !== null && Array.isArray((e as { errors?: unknown }).errors);
}

function checkJs(files: string[], tracked: Set<string>): Problem[] {
	const out: Problem[] = [];
	const t = new Bun.Transpiler({ loader: 'js' });
	for (const file of files) {
		const src = readFileSync(file, 'utf8');
		let imports: { path: string }[];
		try {
			imports = t.scan(src).imports;
		} catch (e) {
			const first = isParseError(e) ? e.errors[0] : undefined;
			out.push({ rule: 'js-syntax', file, line: first?.position?.line ?? 1, col: first?.position?.column ?? 1, message: first?.message ?? String(e) });
			continue;
		}
		for (const { path: spec } of imports) {
			if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
			const target = path.normalize(path.join(path.dirname(file), spec.split('?')[0]!));
			if (tracked.has(target) || target in BUILT) continue;
			out.push({ rule: 'js-import', file, ...locate(src, spec), message: `imports ${spec}, which resolves to ${target}: not a tracked file` });
		}
	}
	return out;
}

function checkShell(files: string[]): Problem[] {
	const out: Problem[] = [];
	for (const file of files) {
		const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
		if (r.error) throw new SetupError(`bash -n cannot run: ${r.error.message}`);
		if (r.status === 0) continue;
		const m = /line (\d+): (.*)/.exec(r.stderr);
		out.push({ rule: 'sh-syntax', file, line: Number(m?.[1] ?? 1), col: 1, message: (m?.[2] ?? r.stderr).trim() });
	}
	return out;
}

const PY = `import json, sys
out = []
for p in sys.argv[1:]:
    try:
        compile(open(p, 'rb').read(), p, 'exec', dont_inherit=True)
    except SyntaxError as e:
        out.append([p, e.lineno or 1, e.offset or 1, e.msg])
print(json.dumps(out))`;

function checkPython(files: string[]): Problem[] {
	const r = spawnSync('python3', ['-I', '-B', '-c', PY, ...files], { encoding: 'utf8' });
	if (r.error || r.status !== 0) throw new SetupError(`python3 cannot compile the sources: ${r.error?.message ?? r.stderr.trim()}`);
	const rows: unknown = JSON.parse(r.stdout);
	if (!Array.isArray(rows)) throw new SetupError(`python3 printed ${r.stdout.slice(0, 200)}`);
	return rows.map(([file, line, col, message]: [string, number, number, string]) => ({ rule: 'py-syntax' as const, file, line, col, message }));
}

/** Why a `uses:` value is not an immutable reference, or null when it is: a local path, an image digest or a full commit SHA. */
function unpinned(uses: unknown): string | null {
	if (typeof uses !== 'string') return `uses must be a string, found ${JSON.stringify(uses)}`;
	if (uses.startsWith('./')) return null;
	if (uses.startsWith('docker://')) return /^docker:\/\/[^\s@]+@sha256:[0-9a-f]{64}$/.test(uses) ? null : `${uses} is not pinned to an image digest (docker://image@sha256:<64 hex>)`;
	return /^[^\s@]+@[0-9a-f]{40}$/.test(uses) ? null : `${uses} is not pinned to a full commit SHA (owner/action@<40 hex>)`;
}

/** Every `uses:` in the file as written: a job's reusable workflow, a step's action, and the steps of a composite action. */
function usesOf(doc: unknown): { has: boolean; uses: unknown; run: unknown }[] {
	const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
	const steps = (v: unknown) => (Array.isArray(v) ? v : []).map(obj);
	const jobs = Object.values(obj(obj(doc).jobs)).map(obj);
	return [...jobs, ...steps(obj(obj(doc).runs).steps), ...jobs.flatMap((j) => steps(j.steps))].map((o) => ({ has: 'uses' in o, uses: o.uses, run: o.run }));
}

function checkWorkflows(files: string[], modes: Map<string, string>): Problem[] {
	const out: Problem[] = [];
	for (const file of files) {
		const src = readFileSync(file, 'utf8');
		const doc: unknown = Bun.YAML.parse(src);
		const isAction = /^\.github\/actions\//.test(file);
		const jobs = typeof doc === 'object' && doc !== null ? (doc as { jobs?: unknown; runs?: unknown })[isAction ? 'runs' : 'jobs'] : undefined;
		if (typeof jobs !== 'object' || jobs === null) {
			out.push({ rule: 'workflow-pin', file, line: 1, col: 1, message: `no ${isAction ? 'runs' : 'jobs'}: not a ${isAction ? 'composite action' : 'workflow'} this check can read` });
			continue;
		}
		for (const { has, uses, run } of usesOf(doc)) {
			const why = has ? unpinned(uses) : null;
			if (why) out.push({ rule: 'workflow-pin', file, ...locate(src, typeof uses === 'string' ? uses : 'uses:'), message: why });
			if (typeof run !== 'string') continue;
			for (const cmd of run.matchAll(/(?:^|[;&|(]|\bthen\b|\bdo\b)\s*(?:\w+=\S*\s+)*((?:scripts|tests)\/[\w./-]+)/gm)) {
				const target = cmd[1]!;
				const mode = modes.get(target);
				if (mode === '100755') continue;
				out.push({ rule: 'workflow-exec', file, ...locate(src, target), message: mode ? `runs ${target}, which is tracked with mode ${mode}, not 100755` : `runs ${target}, which is not a tracked file` });
			}
		}
	}
	return out;
}

function main(): number {
	const { values } = parseArgs({ options: { json: { type: 'string' } }, strict: true });
	const root = git(['rev-parse', '--show-toplevel']).trim();
	process.chdir(root);
	const list: Tracked[] = git(['ls-files', '-s', '-z']).split('\0').filter(Boolean).map((l) => {
		const [meta, file] = l.split('\t') as [string, string];
		return { file, mode: meta.split(' ')[0]! };
	});
	const modes = new Map(list.map((t) => [t.file, t.mode]));
	const tracked = new Set(modes.keys());
	const ext = (...e: string[]) => list.filter((t) => e.includes(path.extname(t.file))).map((t) => t.file);
	const shebang = (t: Tracked) => { try { return /^#!.*\b(ba)?sh\b/.test(readFileSync(t.file, 'utf8').slice(0, 64).split('\n')[0]!); } catch { return false; } };
	const workflows = list.filter((t) => /^\.github\/(workflows\/[^/]+|actions\/(.+\/)?action)\.ya?ml$/.test(t.file)).map((t) => t.file);
	const inputs: Record<Rule, string[]> = {
		'js-syntax': ext('.mjs', '.js', '.cjs'),
		'js-import': ext('.mjs', '.js', '.cjs'),
		'sh-syntax': [...ext('.sh'), ...list.filter((t) => t.mode === '100755' && path.extname(t.file) === '' && shebang(t)).map((t) => t.file)],
		'py-syntax': ext('.py'),
		'workflow-pin': workflows,
		'workflow-exec': workflows,
	};
	const empty = RULES.filter((r) => inputs[r].length === 0);
	if (empty.length) throw new SetupError(`no tracked files for ${empty.join(', ')}: refusing to report a pass over nothing`);
	const problems = [...checkJs(inputs['js-syntax'], tracked), ...checkShell(inputs['sh-syntax']), ...checkPython(inputs['py-syntax']), ...checkWorkflows(workflows, modes)];
	for (const p of problems) console.log(`${p.file}:${p.line}:${p.col}: error [${p.rule}] ${p.message}`);
	const counts = Object.fromEntries(RULES.map((r) => [r, { files: inputs[r].length, problems: problems.filter((p) => p.rule === r).length }]));
	const reproduce = 'bun scripts/ci/source-check.ts';
	if (values.json) writeFileSync(values.json, `${JSON.stringify({ schema: 'clearcase-source-check/1', ok: problems.length === 0, counts, problems, reproduce }, null, 2)}\n`);
	const summary = RULES.map((r) => `${r} ${counts[r]!.problems}/${counts[r]!.files}`).join(', ');
	console.log(`source-check: ${problems.length ? `FAIL ${problems.length} problem(s)` : 'PASS'} (problems/files: ${summary}); reproduce: ${reproduce}`);
	return problems.length ? 1 : 0;
}

try {
	process.exitCode = main();
} catch (e) {
	console.error(`source-check: ERROR ${e instanceof Error ? e.message : String(e)}`);
	process.exitCode = 2;
}
