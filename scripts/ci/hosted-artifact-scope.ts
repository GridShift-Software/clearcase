// Scope for the emitted-artifact capability scan (hosted-artifact.ts). Questions a text pattern cannot answer: does
// `process`/`Bun` here name the runtime global or a binding the module declares itself; does code reach the global
// object in a way the scan cannot resolve; which modules can the Worker run; and is a file that names the global one of
// the reviewed PDF.js browser modules, served as a static asset and never run by the Worker.
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import { scanModule as dynamicImportFacts } from '../../deploy/probes/target.ts';

const GLOBALS = new Set(['process', 'Bun']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'self', 'global']);
// Members of the global object that are the global object again (`globalThis.self.process`).
const GLOBAL_OBJECT_KEYS = new Set([...GLOBAL_OBJECTS, 'window']);
const SYMBOL = Symbol('a symbol key');
const OPTIONS: ts.CompilerOptions = {
	allowJs: true, noLib: true, noResolve: true, types: [], noEmit: true,
	target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleDetection: ts.ModuleDetectionKind.Force,
};

/** `uses`: global uses. `unresolved`: global-object reaches the scan cannot follow, refused in Worker-reachable modules.
 * `imports`: static and string-literal `import()` specifiers. `dynamic`: `import()` calls without one literal specifier. */
export type ModuleScan = { uses: string[]; unresolved: string[]; imports: string[]; dynamic: number; unparsed: string | null };

/** Every use of the process or Bun global in one emitted ES module, resolved by scope, and every reach of the global
 * object (`globalThis`, `self`, `global`) that is not a static member. Not uses: `typeof process` and
 * `process.versions…`. Anything else that reaches the global is a use, optional chaining included
 * (`globalThis.process?.exit?.()`, `process?.[k]`), and so are an alias (`const p = process`), `globalThis.process.exit`,
 * `process["env"]`, `(globalThis).process`, `globalThis[k]` where k is a never-written `"process"`, and
 * `const { process } = globalThis`. The global object itself must appear as `typeof`, a static member, a computed member
 * whose key is a never-written string or `Symbol.for(…)` binding, or the initializer of an object destructure with
 * static keys; an alias, argument, other computed key, rest element or `globalThis.Symbol` is `unresolved`, and so is
 * the global `Symbol` anywhere but `Symbol(…)`, `typeof Symbol` or a static member read. Comments and strings are not code. */
export function scanModule(text: string): ModuleScan {
	const name = '/artifact.mjs';
	const sf = ts.createSourceFile(name, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
	const host: ts.CompilerHost = {
		...ts.createCompilerHost(OPTIONS),
		getSourceFile: (f) => (f === name ? sf : undefined),
		fileExists: (f) => f === name,
		readFile: () => undefined,
		writeFile: () => {},
	};
	const program = ts.createProgram({ rootNames: [name], options: OPTIONS, host });
	const syntax = program.getSyntacticDiagnostics(sf);
	if (syntax.length) return { uses: [], unresolved: [], imports: [], dynamic: 0, unparsed: ts.flattenDiagnosticMessageText(syntax[0]!.messageText, ' ') };
	const checker = program.getTypeChecker();
	const symbolOf = (id: ts.Identifier) => ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
		? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id);
	const local = (id: ts.Identifier) => !!symbolOf(id)?.declarations?.some(binding);
	const free = (n: ts.Node, names: ReadonlySet<string>): n is ts.Identifier => ts.isIdentifier(n) && names.has(n.text) && reference(n) && !local(n);
	// Bindings written anywhere but their declaration; their initializer proves nothing about a later key.
	const written = new Set<ts.Symbol>();
	(function writes(n: ts.Node): void {
		if (ts.isIdentifier(n) && writeTarget(n)) { const s = symbolOf(n); if (s) written.add(s); }
		ts.forEachChild(n, writes);
	})(sf);
	const uses: string[] = [], unresolved: string[] = [], imports: string[] = [];
	let dynamic = 0;
	const property = (n: ts.Node, of: ts.Expression): string | null | undefined => {
		if (ts.isPropertyAccessExpression(n) && n.expression === of) return n.name.text;
		if (ts.isElementAccessExpression(n) && n.expression === of) return ts.isStringLiteralLike(n.argumentExpression) ? n.argumentExpression.text : null;
		return undefined;
	};
	// `Symbol(…)` or `Symbol.for(…)` on the unbound global.
	const symbolCall = (e: ts.Expression) => ts.isCallExpression(e) && !e.questionDotToken && (free(e.expression, SYMBOL_NAME)
		|| (ts.isPropertyAccessExpression(e.expression) && !e.expression.questionDotToken && e.expression.name.text === 'for' && free(e.expression.expression, SYMBOL_NAME)));
	// The value of a binding declared once, never written, and initialised by a string literal or a symbol call.
	const constant = (id: ts.Identifier): string | typeof SYMBOL | null => {
		const s = symbolOf(id), d = s?.declarations;
		if (!s || written.has(s) || d?.length !== 1 || !ts.isVariableDeclaration(d[0]!) || !d[0].initializer) return null;
		const init = strip(d[0].initializer);
		return ts.isStringLiteralLike(init) ? init.text : symbolCall(init) ? SYMBOL : null;
	};
	const keyOf = (m: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | typeof SYMBOL | null => {
		if (ts.isPropertyAccessExpression(m)) return m.name.text;
		const k = strip(m.argumentExpression);
		if (ts.isStringLiteralLike(k) || ts.isNumericLiteral(k)) return k.text;
		return ts.isIdentifier(k) ? constant(k) : null;
	};
	const member = (n: ts.Node): n is ts.PropertyAccessExpression | ts.ElementAccessExpression => ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n);
	const globalObject = (n: ts.Node): boolean => free(n, GLOBAL_OBJECTS)
		|| (member(n) && globalObject(strip(n.expression)) && GLOBAL_OBJECT_KEYS.has(keyOf(n) as string));
	// A global reference: an unbound `process`/`Bun`, or the `process`/`Bun` member of the global object.
	const global = (n: ts.Node): string | undefined => {
		if (ts.isIdentifier(n)) return free(n, GLOBALS) ? n.text : undefined;
		if (!member(n) || !globalObject(strip(n.expression))) return undefined;
		const key = keyOf(n);
		return typeof key === 'string' && GLOBALS.has(key) ? key : undefined;
	};
	const unresolve = (n: ts.Node) => unresolved.push((ts.isVariableDeclaration(n) ? n.parent : n).getText().replace(/\s+/g, ' ').slice(0, 80));
	// Where the global object appears: only positions whose reach the scan follows to a static key.
	const placed = (n: ts.Node) => {
		const o = outer(n), p = o.parent;
		if (ts.isTypeOfExpression(p)) return;
		if (member(p) && p.expression === o) {
			const key = keyOf(p);
			if (key === null || key === 'Symbol') unresolve(p);
			return;
		}
		if (ts.isVariableDeclaration(p) && p.initializer === o && ts.isObjectBindingPattern(p.name)) {
			for (const e of p.name.elements) {
				const at = e.propertyName ?? e.name;
				const key = e.dotDotDotToken ? null : ts.isIdentifier(at) || ts.isStringLiteralLike(at) ? at.text : null;
				if (key === null || GLOBAL_OBJECT_KEYS.has(key) || key === 'Symbol') unresolve(e);
				else if (GLOBALS.has(key)) uses.push(key);
			}
			return;
		}
		unresolve(p);
	};
	const visit = (n: ts.Node): void => {
		const kind = global(n);
		if (kind) {
			const parent = n.parent, key = property(parent, n as ts.Expression);
			const probe = ts.isTypeOfExpression(parent) || (kind === 'process' && key === 'versions');
			if (!probe) uses.push(key ? `${kind}.${key}` : kind);
			if (!ts.isIdentifier(n)) return;
		} else if (globalObject(n)) placed(n);
		else if (free(n, SYMBOL_NAME)) {
			const p = n.parent;
			const read = (ts.isCallExpression(p) && p.expression === n) || ts.isTypeOfExpression(p)
				|| (member(p) && p.expression === n && typeof keyOf(p) === 'string' && !writeTarget(p));
			if (!read) unresolve(p);
		}
		if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) imports.push(n.moduleSpecifier.text);
		if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
			if (n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) imports.push(n.arguments[0].text);
			if (n.arguments.length !== 1 || !ts.isStringLiteralLike(n.arguments[0]!)) dynamic++;
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
	return { uses, unresolved, imports, dynamic, unparsed: null };
}
const SYMBOL_NAME = new Set(['Symbol']);

const strip = (e: ts.Expression): ts.Expression => ts.isParenthesizedExpression(e) ? strip(e.expression) : e;
const outer = (n: ts.Node): ts.Node => ts.isParenthesizedExpression(n.parent) ? outer(n.parent) : n;

// Only a declaration that binds a name makes it local. In a JS file TypeScript also records `globalThis.x = …` as a
// declaration of the global itself, which PDF.js does, so declarations in general prove nothing.
const binding = (d: ts.Declaration) => ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isBindingElement(d)
	|| ts.isFunctionDeclaration(d) || ts.isFunctionExpression(d) || ts.isClassDeclaration(d) || ts.isClassExpression(d)
	|| ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d);

// Positions where an identifier names a property, label or member rather than reading a variable.
function reference(id: ts.Identifier): boolean {
	const p = id.parent;
	if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
	if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) && p.name === id) return false;
	if ((ts.isBindingElement(p) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && p.propertyName === id) return false;
	if (ts.isExportSpecifier(p) && p.propertyName && p.name === id) return false;
	if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p) || ts.isMetaProperty(p)) return false;
	return true;
}

// An assignment, update, for-in/of or delete target, through parentheses and destructuring-assignment patterns.
function writeTarget(n: ts.Node): boolean {
	let at = n;
	while (at.parent && (ts.isParenthesizedExpression(at.parent) || ts.isArrayLiteralExpression(at.parent) || ts.isObjectLiteralExpression(at.parent) || ts.isSpreadElement(at.parent) || ts.isSpreadAssignment(at.parent) || ts.isShorthandPropertyAssignment(at.parent) || (ts.isPropertyAssignment(at.parent) && at.parent.initializer === at))) at = at.parent;
	const p = at.parent;
	if (!p) return false;
	if (ts.isBinaryExpression(p) && p.left === at && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
	if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return true;
	if ((ts.isForInStatement(p) || ts.isForOfStatement(p)) && p.initializer === at) return true;
	return ts.isDeleteExpression(p);
}

export const WORKER_ENTRY = '.svelte-kit/cloudflare/_worker.js';
export const SERVER_OUTPUT = '.svelte-kit/output/server/';
const HOST_SCHEMES = /^(?:node|cloudflare|bun):/;

/** The modules the Worker can run: its entry and every server-output module, then each artifact module they import
 * through a relative static specifier, a string-literal `import()` or a forwarder that deploy/probes/target.ts proves
 * (only ever called with string literals). `via` maps each reached module to the module that reached it (null for a
 * root). An `import()` that proof does not cover, or an absolute-path or URL specifier, is a problem; a bare specifier
 * is a package import, which the source guard (hosted-imports.ts) owns. `host` lists each forwarder's specifiers.
 * Relative edges must name actual JS bytes inside .svelte-kit; load may supply a dependency outside the initial
 * inventory (notably adapter-cloudflare's cloudflare-tmp/server.js). Missing or unsupported edges are problems. */
export function workerReach(modules: ReadonlyMap<string, { text: string; scan: ModuleScan }>, load?: (name: string) => { text: string; scan: ModuleScan }): {
	via: Map<string, string | null>; problems: [string, string][]; host: [string, string][]; edges: Map<string, [string, string][]>;
} {
	const via = new Map<string, string | null>(), problems: [string, string][] = [], host: [string, string][] = [];
	const edges = new Map<string, [string, string][]>();
	const sources = new Map(modules);
	const queue = [...sources.keys()].filter((m) => m === WORKER_ENTRY || m.startsWith(SERVER_OUTPUT)).sort();
	for (const m of queue) via.set(m, null);
	for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
		const { text, scan } = sources.get(name)!, specifiers = [...scan.imports];
		if (scan.dynamic) {
			for (const fact of dynamicImportFacts(text).dynamic ?? []) {
				if (fact.via === 'unproven') problems.push([name, `import() target is not proven at line ${fact.line}: ${fact.reason}`]);
				if (fact.via === 'forwarder') for (const call of fact.calls) (specifiers.push(call.specifier), host.push([name, call.specifier]));
			}
		}
		const resolved: [string, string][] = [];
		for (const s of specifiers) {
			if (s.startsWith('/') || (/^[a-z][a-z0-9+.-]*:/i.test(s) && !HOST_SCHEMES.test(s))) {
				problems.push([name, `imports ${s}, outside the artifact graph`]);
			} else if (/[?%\\\\\x00-\x20\x7f]/.test(s) || (s.includes('#') && !s.startsWith('#')) || s === '.' || s === '..') {
				problems.push([name, `imports ${s}, unsupported module specifier`]);
			} else if (s.startsWith('./') || s.startsWith('../')) {
				const target = path.posix.join(path.posix.dirname(name), s);
				if (!target.startsWith('.svelte-kit/') || !/\.(?:js|mjs|cjs)$/.test(target)) {
					problems.push([name, `imports ${s}, outside the bounded JS artifact graph`]);
					continue;
				}
				try {
					if (!sources.has(target) && load) sources.set(target, load(target));
					if (!sources.has(target)) throw new Error('no artifact bytes');
				} catch (e) {
					problems.push([name, `imports ${s}, unresolved relative module: ${(e as Error).message}`]);
					continue;
				}
				resolved.push([s, target]);
				if (!via.has(target)) (via.set(target, name), queue.push(target));
			}
		}
		edges.set(name, resolved);
	}
	return { via, problems, host, edges };
}

/** The chain of modules by which the Worker reaches `name`. */
export function reachChain(via: ReadonlyMap<string, string | null>, name: string): string[] {
	const chain: string[] = [];
	for (let at: string | null | undefined = name; at; at = via.get(at)) chain.unshift(at);
	return chain;
}

// The PDF.js browser modules prepareHostedPdfAssets copies into the hosted static input. Each entry is the path, size
// and SHA-256 of that file in the inventory whose digest is HOSTED_PDF_PACKAGE_DIGEST (scripts/hosted-pdf-assets.ts);
// tests/hosted-foundation/artifact-scope proves that binding against the frozen install. The modules feature-detect Node
// (`process+""=="[object process]"`, `process.type`) and keep `process.getBuiltinModule` behind that branch; `uses` is
// the reviewed list of global uses at these exact bytes, compared whole, so a scanner change cannot widen it silently.
type PinnedBrowserModule = { asset: string; bytes: number; sha256: string; uses: string[] };
const PDF_PROBE = ['process', 'process.type', 'process.type'];
export const PINNED_BROWSER_MODULES: Readonly<Record<string, PinnedBrowserModule>> = {
	'.svelte-kit/cloudflare/pdfjs/pdf.min.mjs': {
		asset: 'pdfjs/pdf.min.mjs', bytes: 458904,
		sha256: 'sha256:57456c8e0c81e46be31174b499ef77f2b9f5ee46d04412ba627320a36755d4c2',
		uses: [...PDF_PROBE, ...Array<string>(6).fill('process.getBuiltinModule')],
	},
	'.svelte-kit/cloudflare/pdfjs/pdf.worker.min.mjs': {
		asset: 'pdfjs/pdf.worker.min.mjs', bytes: 1264342,
		sha256: 'sha256:9536359f1b8367850d485731ca1d5e45c159a7b7a0912325e539937aa21ceb18',
		uses: PDF_PROBE,
	},
	// The in-app viewer's worker: pdf.worker.min.mjs with WORKER_PATCH, bound by HOSTED_PDF_VIEWER_WORKER_DIGEST.
	'.svelte-kit/cloudflare/pdfjs/pdf-viewer-worker.mjs': {
		asset: 'pdfjs/pdf-viewer-worker.mjs', bytes: 1264489,
		sha256: 'sha256:c14b50d04c16081a41c1756232923c0087bcb3113de3540ada92d6d774fd6115',
		uses: PDF_PROBE,
	},
};

/** Why `name` (root-relative, `/`-separated) does not get its pinned reviewed uses, or null when it does: the exact
 * emitted path, exact bytes, a static asset in Kit's server manifest, unreachable from the Worker (`workerChain` is the
 * chain that reaches it, if one does), and exactly the reviewed uses. */
export function pinnedBrowserRefusal(a: { name: string; bytes: Buffer; uses: string[]; manifestAssets: ReadonlySet<string>; workerChain?: string[] }): string | null {
	const pin = PINNED_BROWSER_MODULES[a.name];
	if (!pin) return 'not a pinned browser module path';
	const sha256 = `sha256:${createHash('sha256').update(a.bytes).digest('hex')}`;
	if (a.bytes.length !== pin.bytes || sha256 !== pin.sha256) return `bytes are not the pinned PDF.js ${pin.asset} (${sha256})`;
	if (!a.manifestAssets.has(pin.asset)) return `${pin.asset} is not a static asset in Kit's server manifest`;
	if (a.workerChain) return `reachable from the Worker (${a.workerChain.join(' -> ')})`;
	const sorted = (l: string[]) => [...l].sort().join(',');
	if (sorted(a.uses) !== sorted(pin.uses)) return `global uses differ from the reviewed list for ${pin.asset}`;
	return null;
}

// Compare the helper's syntax tree, not its filename, a substring or trivia-blind tokens (ASI can change a body).
function syntaxShape(n: ts.Node): string {
	const children: string[] = [];
	ts.forEachChild(n, (child) => { children.push(syntaxShape(child)); });
	return JSON.stringify([n.kind, n.flags & ts.NodeFlags.BlockScoped, ts.isIdentifier(n) ? n.text : null, children]);
}
const MEMO_SHAPE = syntaxShape(ts.createSourceFile('memo.js', 'function __memo(fn) { let value; return () => value ??= (value = fn()); }', ts.ScriptTarget.ESNext, true).statements[0]!);
const stringArray = (e: ts.Expression) => ts.isArrayLiteralExpression(e) && e.elements.every(ts.isStringLiteral);
function inertManifest(expression: ts.Expression, memo: boolean): boolean {
	const e = strip(expression), inert = (x: ts.Expression) => inertManifest(x, memo);
	if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e) || ts.isRegularExpressionLiteral(e)
		|| e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword) return true;
	if (ts.isPrefixUnaryExpression(e)) return (e.operator === ts.SyntaxKind.MinusToken || e.operator === ts.SyntaxKind.PlusToken) && ts.isNumericLiteral(e.operand);
	if (ts.isVoidExpression(e)) return ts.isNumericLiteral(e.expression) && e.expression.text === '0';
	// Creation does not run the function body or its parameter defaults. Such functions are never called here, except
	// the separately proven memo helper below, which only closes over a zero-argument import loader.
	if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
	if (ts.isArrayLiteralExpression(e)) return e.elements.every((x) => ts.isOmittedExpression(x) || inert(x));
	if (ts.isObjectLiteralExpression(e)) {
		const keys = new Set<string>();
		return e.properties.every((p) => {
			if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name))) return false;
			const key = p.name.text;
			if (key === '__proto__' || keys.has(key)) return false;
			keys.add(key);
			return inert(p.initializer);
		});
	}
	if (ts.isNewExpression(e)) return ts.isIdentifier(e.expression) && e.expression.text === 'Set'
		&& e.arguments?.length === 1 && stringArray(strip(e.arguments[0]!));
	if (!memo || !ts.isCallExpression(e) || e.questionDotToken || !ts.isIdentifier(e.expression) || e.expression.text !== '__memo' || e.arguments.length !== 1) return false;
	const fn = strip(e.arguments[0]!);
	if (!ts.isArrowFunction(fn) || fn.parameters.length || fn.modifiers?.length || ts.isBlock(fn.body)) return false;
	const call = strip(fn.body);
	return ts.isCallExpression(call) && call.expression.kind === ts.SyntaxKind.ImportKeyword && call.arguments.length === 1 && ts.isStringLiteral(call.arguments[0]!);
}

const MANIFEST_SHAPE = "Kit's server manifest is not exactly one exported manifest with one literal assets set";
/** Prove the effective exported object, not a decoy or just the spelling of assets. Only inert construction is
 * accepted: literal data, unshadowed intrinsic Set on literal string arrays, deferred functions and Kit's exact
 * memo helper on deferred import loaders. No eager unknown call, alias, intrinsic rewrite or property override can
 * run before or after assets is constructed. This is AST proof, never evaluation of candidate code. */
export function manifestAssets(text: string | undefined): { assets: Set<string>; problem: string | null } {
	const assets = new Set<string>();
	if (text === undefined) return { assets, problem: null };
	const refuse = (why: string) => ({ assets: new Set<string>(), problem: `${MANIFEST_SHAPE}: ${why}` });
	const sf = ts.createSourceFile('manifest.js', text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
	const [statement, ...rest] = sf.statements;
	if ((sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length) return refuse('not parseable');
	if (!statement || rest.length || !ts.isVariableStatement(statement) || statement.modifiers?.length !== 1 || statement.modifiers[0]!.kind !== ts.SyntaxKind.ExportKeyword
		|| !(statement.declarationList.flags & ts.NodeFlags.Const) || statement.declarationList.declarations.length !== 1) return refuse('the module is not the single statement export const manifest = …');
	const decl = statement.declarationList.declarations[0]!;
	if (!ts.isIdentifier(decl.name) || decl.name.text !== 'manifest' || !decl.initializer) return refuse('the exported binding is not manifest');
	let object = strip(decl.initializer), memo = false;
	if (ts.isCallExpression(object)) {
		const fn = strip(object.expression);
		if (object.arguments.length || object.questionDotToken || !ts.isArrowFunction(fn) || fn.parameters.length || fn.modifiers?.length) return refuse('the manifest is not an argument-free arrow IIFE');
		if (ts.isBlock(fn.body)) {
			const body = fn.body.statements, last = body.at(-1);
			const helpers = body.slice(0, -1);
			if (!last || !ts.isReturnStatement(last) || !last.expression || helpers.length > 1
				|| helpers.some((s) => !ts.isFunctionDeclaration(s) || syntaxShape(s) !== MEMO_SHAPE)) return refuse('the IIFE body is not the inert Kit memo helper and one return');
			memo = helpers.length === 1;
			object = strip(last.expression);
		} else object = strip(fn.body);
	}
	if (!ts.isObjectLiteralExpression(object)) return refuse('the manifest is not an object literal');
	if (!inertManifest(object, memo)) return refuse('unproven manifest construction or intrinsic origin');
	const named = (p: ts.ObjectLiteralElementLike) => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === 'assets';
	if (object.properties.some((p) => ts.isSpreadAssignment(p) || (p.name && ts.isComputedPropertyName(p.name)))) return refuse('the manifest object has a spread or computed key');
	const listed = object.properties.filter(named);
	const only = listed[0];
	if (listed.length !== 1 || !only || !ts.isPropertyAssignment(only)) return refuse('assets is not exactly one plain property');
	const set = strip(only.initializer);
	const list = ts.isNewExpression(set) && ts.isIdentifier(set.expression) && set.expression.text === 'Set' && set.arguments?.length === 1 ? strip(set.arguments[0]!) : undefined;
	if (!list || !ts.isArrayLiteralExpression(list) || !list.elements.every((e) => ts.isStringLiteral(e))) return refuse('assets is not new Set([<string literals>])');
	for (const e of list.elements as ts.NodeArray<ts.StringLiteral>) assets.add(e.text);
	return { assets, problem: null };
}
