// Scope for the emitted-artifact capability scan (hosted-artifact.ts). Two questions a text pattern cannot answer:
// does `process`/`Bun` here name the runtime global or a binding the module declares itself, and is a file that
// names the global one of the reviewed PDF.js browser modules, served as a static asset and never run by the Worker.
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';

const GLOBALS = new Set(['process', 'Bun']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'self', 'global']);
const OPTIONS: ts.CompilerOptions = {
	allowJs: true, noLib: true, noResolve: true, types: [], noEmit: true,
	target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleDetection: ts.ModuleDetectionKind.Force,
};

export type ModuleScan = { uses: string[]; imports: string[]; unparsed: string | null };

/** Every use of the process or Bun global in one emitted ES module, resolved by scope, plus its import specifiers.
 * Allowed probes: `typeof process`, `process.versions…` and optional chaining (`globalThis.process?.cwd?.()`), which
 * read undefined where workerd has no such global. Anything else that reaches the global is a use, including an
 * alias (`const p = process`), `globalThis.process.exit` and `process["env"]`. Comments and strings are not code. */
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
	if (syntax.length) return { uses: [], imports: [], unparsed: ts.flattenDiagnosticMessageText(syntax[0]!.messageText, ' ') };
	const checker = program.getTypeChecker();
	const local = (id: ts.Identifier) => {
		const symbol = ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
			? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id);
		return !!symbol?.declarations?.some(binding);
	};
	const uses: string[] = [], imports: string[] = [];
	const property = (n: ts.Node, of: ts.Expression): string | null | undefined => {
		if (ts.isPropertyAccessExpression(n) && n.expression === of) return n.name.text;
		if (ts.isElementAccessExpression(n) && n.expression === of) return ts.isStringLiteralLike(n.argumentExpression) ? n.argumentExpression.text : null;
		return undefined;
	};
	// A global reference: an unbound `process`/`Bun`, or `globalThis.process` / `globalThis["Bun"]` on an unbound global object.
	const global = (n: ts.Node): string | undefined => {
		if (ts.isIdentifier(n)) return GLOBALS.has(n.text) && reference(n) && !local(n) ? n.text : undefined;
		if (!ts.isPropertyAccessExpression(n) && !ts.isElementAccessExpression(n)) return undefined;
		const of = n.expression, key = property(n, of);
		return key && GLOBALS.has(key) && ts.isIdentifier(of) && GLOBAL_OBJECTS.has(of.text) && !local(of) ? key : undefined;
	};
	const visit = (n: ts.Node): void => {
		const kind = global(n);
		if (kind) {
			const parent = n.parent, key = property(parent, n as ts.Expression);
			const probe = ts.isTypeOfExpression(parent)
				|| (key !== undefined && (!!(parent as ts.PropertyAccessExpression).questionDotToken || (kind === 'process' && key === 'versions')));
			if (!probe) uses.push(key ? `${kind}.${key}` : kind);
			if (!ts.isIdentifier(n)) return;
		}
		if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) imports.push(n.moduleSpecifier.text);
		if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) imports.push(n.arguments[0].text);
		ts.forEachChild(n, visit);
	};
	visit(sf);
	return { uses, imports, unparsed: null };
}

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
};

/** Why `name` (root-relative, `/`-separated) does not get its pinned reviewed uses, or null when it does: the exact
 * emitted path, exact bytes, a static asset in Kit's server manifest, and exactly the reviewed uses. */
export function pinnedBrowserRefusal(a: { name: string; bytes: Buffer; uses: string[]; manifestAssets: ReadonlySet<string> }): string | null {
	const pin = PINNED_BROWSER_MODULES[a.name];
	if (!pin) return 'not a pinned browser module path';
	const sha256 = `sha256:${createHash('sha256').update(a.bytes).digest('hex')}`;
	if (a.bytes.length !== pin.bytes || sha256 !== pin.sha256) return `bytes are not the pinned PDF.js ${pin.asset} (${sha256})`;
	if (!a.manifestAssets.has(pin.asset)) return `${pin.asset} is not a static asset in Kit's server manifest`;
	const sorted = (l: string[]) => [...l].sort().join(',');
	if (sorted(a.uses) !== sorted(pin.uses)) return `global uses differ from the reviewed list for ${pin.asset}`;
	return null;
}

/** The static asset paths Kit's server manifest lists (`assets: new Set([...])`), or an empty set without one. */
export function manifestAssets(text: string | undefined): Set<string> {
	const assets = new Set<string>();
	if (text === undefined) return assets;
	const visit = (n: ts.Node): void => {
		if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'assets' && ts.isNewExpression(n.initializer)
			&& ts.isIdentifier(n.initializer.expression) && n.initializer.expression.text === 'Set') {
			const list = n.initializer.arguments?.[0];
			if (list && ts.isArrayLiteralExpression(list)) for (const e of list.elements) if (ts.isStringLiteral(e)) assets.add(e.text);
		}
		ts.forEachChild(n, visit);
	};
	visit(ts.createSourceFile('manifest.js', text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS));
	return assets;
}

/** A Worker-side module (the Worker entry or Kit's server output) whose relative import resolves to a pinned browser module. */
export function serverImportOfPinned(name: string, imports: string[]): string | undefined {
	if (name !== '.svelte-kit/cloudflare/_worker.js' && !name.startsWith('.svelte-kit/output/server/')) return undefined;
	return imports.find((s) => s.startsWith('.') && path.posix.join(path.posix.dirname(name), s) in PINNED_BROWSER_MODULES);
}
