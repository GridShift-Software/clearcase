// The migration surface (GRS-106 for GRS-112): every file the hosted entry graph would import that itself uses the
// filesystem, SQLite, process state or listeners, or browser-local persistence. From this directory:
//
//   bun run --bun surface
//
// The graph starts at SvelteKit's entry files under src/ (hooks, and every +page/+layout/+server/+error route file,
// tests excluded) and follows static imports, re-exports, literal dynamic imports and import.meta.glob patterns,
// through `$lib` and relative paths, into any directory; type-only imports are erased first, as the build does. Each
// reachable file is then matched by module (node:fs, node:sqlite, …) and by line (process.on, sessionStorage, …).
// It prints a Markdown table, one row per file with every matching line, then the counts, the other Node built-ins
// and packages the graph reaches, any dynamic import it could not resolve, and which scripts/pilot files it reaches.
// It reads the working tree and changes nothing.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** The two Bun APIs this script uses; the root project has no @types/bun. */
declare const Bun: {
	Transpiler: new (options: { loader: 'ts' }) => { scan(code: string): { imports: { path: string; kind: string }[] } };
	Glob: new (pattern: string) => { scanSync(options: { cwd: string }): Iterable<string> };
};

const ROOT = path.resolve(import.meta.dirname, '../../..');
type Category = 'filesystem' | 'sqlite' | 'process' | 'browser-local';
const CATEGORIES: Category[] = ['filesystem', 'sqlite', 'process', 'browser-local'];

const MODULES: Record<string, Category> = {
	'node:fs': 'filesystem',
	'node:fs/promises': 'filesystem',
	'node:os': 'filesystem',
	'node:sqlite': 'sqlite',
	'bun:sqlite': 'sqlite',
	'node:child_process': 'process',
	'node:net': 'process',
	'node:http': 'process',
	'node:https': 'process',
	'node:worker_threads': 'process',
	'node:cluster': 'process',
};
const LINES: [Category, RegExp][] = [
	['filesystem', /\bprocess\.(cwd|chdir)\(|\bBun\.(file|write)\(/],
	['sqlite', /\.prepare\(|\.storage\.db\(\)|\bdb\(\)\.exec\(/],
	['process', /\bprocess\.(on|once|off|addListener|exit|kill|pid|ppid|env|argv|umask|uptime|memoryUsage)\b|\bBun\.(serve|spawn|spawnSync)\(|\.listen\(/],
	['browser-local', /\b(localStorage|sessionStorage|indexedDB|navigator\.storage|caches\.open)\b|\bdocument\.cookie\b/],
];

const ENTRY = /^(hooks(\.server|\.client)?\.(ts|js)|service-worker\.(ts|js)|\+(page|layout|server|error)(@[^.]*)?(\.server)?\.(ts|js|svelte))$/;
const transpiler = new Bun.Transpiler({ loader: 'ts' });
const isFile = (f: string) => existsSync(f) && statSync(f).isFile();
const rel = (f: string) => path.relative(ROOT, f);

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/** The code a file's imports live in: a Svelte file's <script> blocks, or the whole file. */
const scripts = (file: string, text: string) => (file.endsWith('.svelte') ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).join('\n') : text);

function resolve(from: string, spec: string): string | null {
	const bare = spec.split('?')[0]!;
	let base: string;
	if (bare === '$lib' || bare.startsWith('$lib/')) base = path.join(ROOT, 'src/lib', bare.slice(4));
	else if (bare.startsWith('./') || bare.startsWith('../')) base = path.resolve(path.dirname(from), bare);
	else if (bare.startsWith('/src/')) base = path.join(ROOT, bare);
	else return null;
	for (const c of [base, `${base}.ts`, `${base}.js`, `${base}.svelte`, base.replace(/\.js$/, '.ts'), path.join(base, 'index.ts'), path.join(base, 'index.js')]) if (isFile(c)) return c;
	throw new Error(`${rel(from)}: cannot resolve ${spec}`);
}

const entries = walk(path.join(ROOT, 'src')).filter((f) => ENTRY.test(path.basename(f)) && !f.includes('.test.'));
const seen = new Set<string>();
const queue = [...entries];
const builtins = new Map<string, Set<string>>();
const packages = new Map<string, Set<string>>();
const unresolved: string[] = [];
const hits = new Map<string, { category: Category; line: number; text: string }[]>();
const importers = new Map<string, Set<string>>();

while (queue.length) {
	const file = queue.pop()!;
	if (seen.has(file)) continue;
	seen.add(file);
	const text = readFileSync(file, 'utf8');
	const code = scripts(file, text);
	const specs = /\.(ts|js|mjs|svelte)$/.test(file) ? transpiler.scan(code).imports.map((i) => i.path) : [];
	for (const m of code.matchAll(/import\.meta\.glob(?:<[^>]*>)?\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/g))
		for (const pattern of [...m[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((p) => p[1]!)) {
			const dir = pattern.startsWith('/') ? ROOT : path.dirname(file);
			for (const f of new Bun.Glob(pattern.replace(/^\//, '')).scanSync({ cwd: dir })) specs.push(pattern.startsWith('/') ? `/${f}` : `./${f}`);
		}
	// a computed dynamic import; not a method named import (`x.import(…)`, `import(ctx: T)`)
	for (const m of code.matchAll(/(?<![\w.$])import\(\s*(?![\w$]+\??\s*:)([^'"\s)][^)]*)\)/g)) unresolved.push(`${rel(file)}: import(${m[1]})`);
	const found: { category: Category; line: number; text: string }[] = [];
	const lines = text.split('\n');
	for (const spec of specs) {
		const target = resolve(file, spec);
		if (target) {
			importers.set(target, (importers.get(target) ?? new Set()).add(file));
			queue.push(target);
			continue;
		}
		const name = spec.startsWith('node:') ? spec : /^(fs|os|path|url|crypto|util|stream|zlib|buffer|events|child_process|net|http|https|async_hooks|worker_threads)(\/|$)/.test(spec) ? `node:${spec}` : null;
		if (name) {
			builtins.set(name, (builtins.get(name) ?? new Set()).add(rel(file)));
			const category = MODULES[name];
			const at = lines.findIndex((l) => l.includes(`'${spec}'`) || l.includes(`"${spec}"`));
			if (category) found.push({ category, line: at + 1, text: `import ${name}` });
		} else if (!spec.startsWith('$app/') && !spec.startsWith('$env/')) {
			const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
			packages.set(pkg, (packages.get(pkg) ?? new Set()).add(rel(file)));
		}
	}
	lines.forEach((l, i) => {
		const t = l.trim();
		if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
		for (const [category, re] of LINES) {
			const m = l.match(re);
			if (m) found.push({ category, line: i + 1, text: m[0] });
		}
	});
	if (found.length) hits.set(file, found);
}

const files = [...hits.keys()].sort((a, b) => rel(a).localeCompare(rel(b)));
console.log('| File | Categories | Lines |');
console.log('| --- | --- | --- |');
for (const f of files) {
	const found = hits.get(f)!;
	const cats = CATEGORIES.filter((c) => found.some((h) => h.category === c));
	const lines = [...new Map(found.map((h) => [`${h.line}`, `${h.line} \`${h.text.replace(/\|/g, '\\|')}\``])).values()];
	console.log(`| \`${rel(f)}\` | ${cats.join(', ')} | ${lines.join(', ')} |`);
}
console.log();
// Second tier: files that import a surface file directly. They reach the local dependency only through it, so each
// needs that file's replacement interface (awaited, injected per request) rather than a platform swap of its own.
const tier2 = new Set<string>();
for (const f of files) {
	const by = [...(importers.get(f) ?? [])].filter((i) => !hits.has(i)).map(rel).sort();
	by.forEach((i) => tier2.add(i));
	if (by.length) console.log(`- \`${rel(f)}\` (${by.length}): ${by.map((i) => `\`${i}\``).join(', ')}`);
}
console.log();
console.log(`second tier: ${tier2.size} files import a surface file directly`);
const count = (c: Category) => files.filter((f) => hits.get(f)!.some((h) => h.category === c)).length;
console.log(`entries ${entries.length}; reachable files ${seen.size}; surface files ${files.length}: ${CATEGORIES.map((c) => `${c} ${count(c)}`).join(', ')}`);
const others = [...builtins].filter(([n]) => !MODULES[n]).sort();
console.log(`other Node built-ins: ${others.map(([n, s]) => `${n} (${s.size})`).join(', ') || 'none'}`);
console.log(`packages: ${[...packages].sort().map(([n, s]) => `${n} (${s.size})`).join(', ') || 'none'}`);
console.log(`unresolved dynamic imports: ${unresolved.join('; ') || 'none'}`);
const pilot = [...seen].filter((f) => rel(f).startsWith('scripts/pilot/')).map(rel);
const outside = [...seen].filter((f) => !rel(f).startsWith('src/')).map(rel).sort();
console.log(`scripts/pilot files reached: ${pilot.join(', ') || 'none'}; files reached outside src/: ${outside.join(', ') || 'none'}`);
