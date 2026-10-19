import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import ts from 'typescript';
import { compile } from 'svelte/compiler';

const local = /^(?:src\/lib\/(?:local-case\/(?:app|db|store|service|config|case-pack|fsafe|originals)\.server\.ts|local-case\/rescan\/rescan\.server\.ts|user-work\/backup\/(?:backup|legacy|v5-importers)\.server\.ts|views\/system\/(?:manual|rescan|backup)\.server\.ts|views\/bundles\/(?:links|store)\.server\.ts|case-package\/(?:index|source|zip|originals|writer|import)\.ts|case-package\/v5\/))/;
const nodeModules = new Set(builtinModules.map((m) => m.replace(/^node:/, '')));
const safeBuiltins = new Set(['crypto']);
// Packages a hosted module may import. Their internals are the framework's, proven on workerd by the hosted smoke run and
// checked again in the emitted artifact (scripts/ci/hosted-artifact.ts); they are not walked here. Any other package fails.
const hostedPackages = new Set(['svelte', '@sveltejs/kit', 'typebox']);
// SvelteKit's virtual app modules and the one Workers runtime module a hosted module may name.
const virtualModules = /^(?:\$app\/(?:env|forms|navigation|paths|state)|cloudflare:workers)$/;
// Test doubles: the memory doubles serve unit tests only; the gate doubles exist only in the hosted-gate profile.
const memoryDouble = /^src\/lib\/server\/runtime\/memory[^/]*\.ts$/;
const gateDouble = /^src\/lib\/server\/runtime\/hosted\/gate\//;
export type HostedProfile = 'production' | 'hosted-gate';
const packageOf = (specifier: string) => /^(?:@[^/]+\/)?[^/.$][^/]*/.exec(specifier)?.[0] ?? null;
const extensions = ['.ts', '.js', '.mjs', '.svelte'];
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** The routes and server hooks one hosted profile builds; a profile entry may replace the hooks and nothing else. */
export function selected(root: string, profile: HostedProfile = 'production') {
  const files: unknown = JSON.parse(readFileSync(path.join(root, 'deploy/client/hosted-files.json'), 'utf8'));
  if (!record(files) || typeof files.routes !== 'string' || !record(files.hooks) || typeof files.hooks.server !== 'string') throw new Error('invalid hosted file selection');
  if (profile === 'production') return { routes: files.routes, hooks: { server: files.hooks.server } };
  const entry = record(files.profiles) ? files.profiles[profile] : undefined;
  if (!record(entry) || Object.keys(entry).join() !== 'hooks' || !record(entry.hooks) || typeof entry.hooks.server !== 'string') throw new Error(`invalid hosted file selection for ${profile}`);
  return { routes: files.routes, hooks: { server: entry.hooks.server } };
}
const slash = (s: string) => s.replaceAll(path.sep, '/');
const literal = (n: ts.Node | undefined) => n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;

export function checkHostedGraph(a: { root: string; profile?: HostedProfile }): { errors: string[]; files: string[] } {
  const profile = a.profile ?? 'production';
  const root = realpathSync(a.root), errors: string[] = [], visited = new Set<string>();
  const relative = (file: string) => slash(path.relative(root, file));
  function fail(chain: string[], reason: string) { errors.push(`hosted-import: ${chain.join(' -> ')}: ${reason}`); }
  function inside(file: string) {
    const p = relative(file);
    if (p.startsWith('../') || path.isAbsolute(p) || /(?:^|\/)(?:RAWS|\.local)(?:\/|$)/.test(p)) throw new Error('outside hosted source boundary');
  }
  function walk(dir: string): string[] {
    inside(dir);
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) { const real = realpathSync(p); inside(real); return statSync(real).isDirectory() ? walk(real) : [real]; }
      return e.isDirectory() ? walk(p) : [p];
    });
  }
  let config: ReturnType<typeof selected>, options: ts.CompilerOptions;
  try {
    config = selected(root, profile);
    const raw = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
    if (raw.error) throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText, ' '));
    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, root);
    // Missing generated configuration is an unresolved graph, not permission to ignore aliases.
    if (parsed.errors.some((e) => e.code !== 18003)) throw new Error(ts.flattenDiagnosticMessageText(parsed.errors[0]!.messageText, ' '));
    options = parsed.options;
  } catch (e) { fail(['configuration'], e instanceof Error ? e.message : 'unreadable configuration'); return { errors, files: [] }; }
  function resolve(specifier: string, importer: string, chain: string[]) {
    const bare = specifier.replace(/^node:/, '');
    if (virtualModules.test(specifier)) return;
    if (specifier.startsWith('bun:') || specifier.startsWith('cloudflare:') || nodeModules.has(bare) || specifier.startsWith('node:')) {
      if (!safeBuiltins.has(bare)) fail(chain, `forbidden capability ${specifier}`);
      return;
    }
    // TypeScript does not resolve Svelte components; a component is named by a relative or $lib path, nothing else.
    if (specifier.endsWith('.svelte')) {
      const file = specifier.startsWith('./') || specifier.startsWith('../') ? path.resolve(path.dirname(importer), specifier) : specifier.startsWith('$lib/') ? path.join(root, 'src/lib', specifier.slice(5)) : null;
      if (file === null || !existsSync(file)) fail(chain, `unresolved ${specifier}`); else visit(file, chain);
      return;
    }
    const module = ts.resolveModuleName(specifier, importer, options, ts.sys).resolvedModule, resolved = module?.resolvedFileName;
    if (module?.isExternalLibraryImport) {
      const name = packageOf(specifier);
      if (!name || !hostedPackages.has(name)) fail(chain, `package outside the hosted allowlist ${specifier}`);
      return;
    }
    if (!resolved || resolved.endsWith('.d.ts') || resolved.endsWith('.d.mts') || resolved.endsWith('.d.cts')) { fail(chain, `unresolved ${specifier}`); return; }
    visit(resolved, chain);
  }
  // Vite's glob semantics, narrowed to what the guard can match exactly: `*` within a segment and `**` as a whole segment
  // (zero or more directories). Braces, classes, `?` and extglobs fail closed instead of being approximated.
  function expression(pattern: string) {
    const parts = pattern.split('/');
    return new RegExp('^' + parts.map((part, i) => {
      const last = i === parts.length - 1;
      if (part === '**') return last ? '.*' : '(?:[^/]*/)*';
      if (part.includes('**') || /[{}[\]?()+@!]/.test(part)) throw new Error('unsupported glob syntax');
      return part.split('*').map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + (last ? '' : '/');
    }).join('') + '$');
  }
  function glob(patterns: string[], importer: string, chain: string[]) {
    const matches = new Set<string>();
    for (const original of patterns) {
      const negative = original.startsWith('!'), p = negative ? original.slice(1) : original;
      let absolute: string;
      if (p.startsWith('./') || p.startsWith('../')) absolute = path.resolve(path.dirname(importer), p);
      else if (p.startsWith('$lib/')) absolute = path.join(root, 'src/lib', p.slice(5));
      else if (p.startsWith('/')) absolute = path.join(root, p);
      else { fail(chain, `unresolved glob ${original}`); continue; }
      try {
        // match root-relative paths, so characters in the checkout's own location are never read as glob syntax
        const within = relative(absolute);
        if (within.startsWith('../') || path.isAbsolute(within)) throw new Error('outside hosted source boundary');
        const pattern = expression(within), parts = within.split('/'), wildcard = parts.findIndex((part) => part.includes('*'));
        const prefix = path.join(root, wildcard < 0 ? path.dirname(within) : parts.slice(0, wildcard).join('/'));
        for (const file of walk(prefix)) if (pattern.test(relative(file))) { if (negative) matches.delete(file); else matches.add(file); }
      } catch (e) { fail(chain, `unsupported glob ${original}: ${e instanceof Error ? e.message : 'unreadable directory'}`); }
    }
    for (const file of [...matches].sort()) visit(file, chain);
  }
  function visit(input: string, prior: string[]) {
    let file: string;
    try { file = realpathSync(input); inside(file); } catch { fail([...prior, relative(input)], 'unresolved or outside hosted source boundary'); return; }
    const name = relative(file), chain = [...prior, name];
    if (local.test(name)) { visited.add(file); fail(chain, 'forbidden local implementation'); return; }
    if (memoryDouble.test(name) || gateDouble.test(name) && profile !== 'hosted-gate') { visited.add(file); fail(chain, `forbidden test double in the ${profile} graph`); return; }
    if (visited.has(file)) return;
    visited.add(file);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
      if (file.endsWith('.svelte')) text = compile(text, { filename: file, generate: 'server' }).js.code;
      const emitted = ts.transpileModule(text, { fileName: file, compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true }, reportDiagnostics: true });
      if (emitted.diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error)) throw new Error('unparseable module');
      text = emitted.outputText;
    } catch (e) { fail(chain, e instanceof Error ? e.message : 'unreadable module'); return; }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function scan(node: ts.Node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        const specifier = literal(node.moduleSpecifier);
        if (specifier === null) fail(chain, 'computed module import'); else resolve(specifier, file, chain);
      }
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          const specifier = literal(node.arguments[0]);
          if (specifier === null) fail(chain, 'computed runtime import'); else resolve(specifier, file, chain);
        }
        if (ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source) === 'import.meta' && node.expression.name.text === 'glob') {
          const [first, options] = node.arguments, values = first && ts.isArrayLiteralExpression(first) ? first.elements.map(literal) : [literal(first)];
          // `base` moves resolution and `exhaustive` widens it; only options that leave the matched files alone are accepted
          const keys = options === undefined ? [] : ts.isObjectLiteralExpression(options) ? options.properties.map((p) => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && ts.isPropertyAssignment(p) ? p.name.text : null) : [null];
          if (values.some((v) => v === null)) fail(chain, 'computed runtime glob');
          else if (keys.some((k) => k === null || !['eager', 'import', 'query'].includes(k))) fail(chain, `unsupported glob options in ${values.join(', ')}`);
          else glob(values.filter((v): v is string => v !== null), file, chain);
        }
      }
      if (ts.isIdentifier(node) && ['process', 'Bun', 'eval', 'Function', '__non_webpack_require__'].includes(node.text)) fail(chain, `forbidden capability ${node.text}`);
      if (ts.isIdentifier(node) && node.text === 'require' && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) fail(chain, 'unresolved require alias');
      if (ts.isElementAccessExpression(node) && node.expression.getText(source) === 'globalThis') {
        const property = literal(node.argumentExpression);
        if (property === null || property === 'process' || property === 'Bun') fail(chain, 'forbidden computed global capability');
      }
      if (ts.isStringLiteral(node) && /^(?:\/proc(?:\/|$)|\/tmp(?:\/|$))/.test(node.text)) fail(chain, 'forbidden local path');
      ts.forEachChild(node, scan);
    }
    scan(source);
  }
  try {
    const hooksBase = path.resolve(root, config.hooks.server);
    const hooks = extensions.map((e) => hooksBase + e).find(existsSync);
    if (!hooks) fail(['hooks'], 'unresolved hosted hooks'); else visit(hooks, []);
    const routes = walk(path.resolve(root, config.routes)).filter((file) => /\/(?:\+(?:page|layout)(?:\.server)?|\+server|\+error)\.(?:ts|js|svelte)$/.test(slash(file)));
    if (!routes.length) fail(['routes'], 'empty hosted route selection');
    for (const route of routes.sort()) visit(route, []);
  } catch (e) { fail(['roots'], e instanceof Error ? e.message : 'unreadable roots'); }
  return { errors: [...new Set(errors)], files: [...visited].map(relative).sort() };
}
export function assertHostedGraph(root: string, profile: HostedProfile = 'production') {
  const result = checkHostedGraph({ root, profile });
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const rootIndex = process.argv.indexOf('--root'), root = rootIndex < 0 ? process.cwd() : process.argv[rootIndex + 1];
    if (!root) throw new Error('missing --root value');
    // Both profiles: the production graph without any test double, and the hosted-gate graph with only its own.
    for (const profile of ['production', 'hosted-gate'] as const) {
      const result = assertHostedGraph(root, profile);
      console.log(`hosted-import: PASS ${profile} (${result.files.length} selected source modules)`);
    }
  } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
}
