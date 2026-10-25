// Positive public provenance, without evaluating a build module or trusting a sidecar's "client" labels.
// The pinned final entry's *used* Kit manifest seeds static assets and the browser graph. Browser imports,
// Vite's preload table and CSS URLs extend that graph. The build lane additionally compares bytes to output/client.
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';

const PUB = 'artifact/public/';
const hash = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const literal = (n: ts.Node | undefined): string | undefined => n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined;
const parse = (text: string, name: string) => {
	const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const errors = (sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
	if (errors?.length) throw new Error(`${name}: invalid JavaScript in public provenance input`);
	return sf;
};
function visit(n: ts.Node, fn: (n: ts.Node) => void): void { fn(n); n.forEachChild(c => visit(c, fn)); }
function property(o: ts.ObjectLiteralExpression, name: string): ts.Expression {
	const found = o.properties.filter(p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name);
	if (found.length !== 1 || !ts.isPropertyAssignment(found[0]!)) throw new Error(`public provenance: manifest property ${name} is not one explicit property`);
	return found[0]!.initializer;
}
function strings(n: ts.Expression): string[] {
	if (!ts.isArrayLiteralExpression(n)) throw new Error('public provenance: expected a literal path array');
	return n.elements.map(e => { const s = literal(e); if (s === undefined) throw new Error('public provenance: computed path'); return s; });
}
function manifestPaths(entry: string): string[] {
	const sf = parse(entry, 'final Worker entry');
	const decls = sf.statements.flatMap(s => ts.isVariableStatement(s) ? [...s.declarationList.declarations] : []);
	const named = (name: string) => {
		const d = decls.filter(d => ts.isIdentifier(d.name) && d.name.text === name);
		if (d.length !== 1 || !d[0]!.initializer) throw new Error(`public provenance: ${name} is not one initialized module binding`);
		return d[0]!.initializer!;
	};
	// Follow the default export's actual server.respond receiver, not an arbitrary manifest-shaped object.
	const exports: ts.Expression[] = [];
	for (const s of sf.statements) {
		if (ts.isExportAssignment(s) && !s.isExportEquals) exports.push(s.expression);
		if (ts.isExportDeclaration(s) && !s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause))
			for (const e of s.exportClause.elements) if (e.name.text === 'default') exports.push(ts.factory.createIdentifier((e.propertyName ?? e.name).text));
	}
	if (exports.length !== 1) throw new Error('public provenance: expected one default Worker export');
	const exported = exports[0]!;
	const worker = ts.isIdentifier(exported) ? named(exported.text) : exported;
	if (!ts.isObjectLiteralExpression(worker)) throw new Error('public provenance: default Worker is not the pinned adapter object');
	const receivers = new Set<string>();
	visit(worker, n => {
		if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'respond' && ts.isIdentifier(n.expression.expression)) receivers.add(n.expression.expression.text);
	});
	if (receivers.size !== 1) throw new Error('public provenance: expected one server.respond receiver in the default Worker');
	const server = named([...receivers][0]!);
	if (!ts.isCallExpression(server) || !ts.isIdentifier(server.expression) || server.expression.text !== 'create_server' || server.arguments.length !== 1 || !ts.isIdentifier(server.arguments[0]!)) throw new Error('public provenance: server is not create_server(manifest)');
	const init = named((server.arguments[0] as ts.Identifier).text);
	if (!ts.isCallExpression(init) || init.arguments.length || !ts.isParenthesizedExpression(init.expression) || !ts.isArrowFunction(init.expression.expression)) throw new Error('public provenance: manifest is not the pinned Kit IIFE');
	const fn = init.expression.expression;
	if (fn.parameters.length || !ts.isBlock(fn.body)) throw new Error('public provenance: unexpected manifest IIFE');
	const returns = fn.body.statements.filter(ts.isReturnStatement);
	const obj = returns.length === 1 ? returns[0]!.expression : undefined;
	if (!obj || !ts.isObjectLiteralExpression(obj) || literal(property(obj, 'app_dir')) !== '_app' || literal(property(obj, 'app_path')) !== '_app') throw new Error('public provenance: unexpected Kit app manifest');
	const assets = property(obj, 'assets');
	if (!ts.isNewExpression(assets) || !ts.isIdentifier(assets.expression) || assets.expression.text !== 'Set' || assets.arguments?.length !== 1) throw new Error('public provenance: static assets are not the Kit literal Set');
	const client = property(obj, 'client');
	if (!ts.isObjectLiteralExpression(client)) throw new Error('public provenance: missing browser manifest');
	const paths = [...strings(assets.arguments[0]!), '_app/version.json'];
	for (const k of ['start', 'app']) {
		const p = literal(property(client, k)); if (!p) throw new Error(`public provenance: missing client.${k}`); paths.push(p);
	}
	for (const k of ['imports', 'stylesheets', 'fonts']) paths.push(...strings(property(client, k)));
	return paths;
}

/** All paths and sizes/hashes are checked against the actual descriptor-read bytes, never self-certified metadata.
 * No fallback: an entry without the pinned adapter/Kit manifest shape cannot establish public provenance.
 * This is provenance within an already pinned build, not a proof that attacker-authored entry/browser code is safe.
 */
export function nativePublicAssetProvenance(a: { entryText: string; publicFiles: ReadonlyMap<string, Buffer>; files: readonly {path: string; bytes: number; sha256: string}[] }): string[] {
	const problems: string[] = [];
	const entry = a.files.find(f => f.path === 'artifact/cloudflare/_worker.js');
	if (!entry || Buffer.byteLength(a.entryText) !== entry.bytes || hash(Buffer.from(a.entryText)) !== entry.sha256) problems.push('public provenance is not bound to the actual final entry bytes');
	const filePaths = new Set(a.files.map(f => f.path));
	for (const at of a.publicFiles.keys()) if (!at.startsWith(PUB) || !filePaths.has(at)) problems.push(`${at}: public provenance includes bytes outside the actual file inventory`);
	const allowed = new Set<string>();
	const pending: string[] = [];
	const add = (rel: string) => {
		if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.split('/').some(s => !s || s === '.' || s === '..') || /[?#%\x00-\x1f]/.test(rel)) throw new Error(`public provenance: unsafe path ${JSON.stringify(rel)}`);
		if (!allowed.has(rel)) { allowed.add(rel); pending.push(rel); }
	};
	const dependency = (from: string, spec: string) => {
		if (/^(?:data:|https?:|#)/.test(spec)) return;
		if (!spec.startsWith('.') && !spec.startsWith('/')) throw new Error(`${from}: non-relative browser dependency ${spec}`);
		add(path.posix.normalize(spec.startsWith('/') ? spec.slice(1) : path.posix.join(path.posix.dirname(from), spec)));
	};
	try {
		for (const p of manifestPaths(a.entryText)) add(p);
		while (pending.length) {
			const rel = pending.pop()!;
			const b = a.publicFiles.get(PUB + rel);
			if (!b) throw new Error(`${PUB + rel}: missing manifest/browser dependency`);
			// Static files are fully enumerated by Kit's static Set; no need to interpret static PDF.js as app code.
			if (!rel.startsWith('_app/') || !/\.(?:m?js|css)$/.test(rel)) continue;
			const text = new TextDecoder('utf-8', { fatal: true }).decode(b);
			if (/\.(?:m?js)$/.test(rel)) {
				visit(parse(text, rel), n => {
					if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) {
						const s = literal(n.moduleSpecifier); if (s === undefined) throw new Error(`${rel}: computed browser import`); dependency(rel, s);
					}
					if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
						const s = literal(n.arguments[0]); if (s === undefined || n.arguments.length !== 1) throw new Error(`${rel}: computed browser import`); dependency(rel, s);
					}
					// Pinned Vite preload table, not arbitrary string arrays in a module.
					if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === '__vite__mapDeps' && n.initializer && ts.isArrowFunction(n.initializer)) {
						visit(n.initializer, x => { if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(x.left) && x.left.name.text === 'f' && ts.isArrayLiteralExpression(x.right)) for (const p of strings(x.right)) dependency(rel, p); });
					}
					if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'URL' && n.arguments?.length === 2 && n.arguments[1]!.getText() === 'import.meta.url') {
						const s = literal(n.arguments[0]); if (s !== undefined) dependency(rel, s); // Runtime routing URLs grant no asset paths.
					}
				});
			} else if (rel.endsWith('.css')) {
				for (const m of text.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)) dependency(rel, m[1]!);
			}
		}
	} catch (e) { problems.push((e as Error).message); }
	for (const f of a.files) if (f.path.startsWith(PUB)) {
		const b = a.publicFiles.get(f.path);
		if (!b || b.length !== f.bytes || hash(b) !== f.sha256) problems.push(`${f.path}: public provenance is not bound to its actual bytes`);
		if (f.path !== PUB + '_headers' && !allowed.has(f.path.slice(PUB.length))) problems.push(`${f.path}: no positive browser/static provenance in the pinned entry's used manifest or browser graph`);
	}
	return problems;
}
