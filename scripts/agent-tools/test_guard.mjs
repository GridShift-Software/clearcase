// Conservative protection: a named callback must retain every executable token.
// The TypeScript parser handles JS/TS syntax without running tests or loading their imports.
// Protected: the named tests; the test code they import (files under test-support directories); the runner
// configuration, the local modules it imports, its setup files and test scripts; and the fixtures they read or that sit
// in the test tree. The modules under test (src/, scripts/) are not protected: a fix is expected to change them, but no
// changed one may reach the test framework.
import ts from 'typescript';
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const SUPPORT_DIR = /^(?:tests?|__tests__|e2e|support|test-?utils?|test-?helpers?|fixtures?|__fixtures__|__mocks__|__snapshots__)$/;
const FIXTURE_DIR = /^(?:fixtures?|__fixtures__|__mocks__|__snapshots__)$/;
// A test file: the runner collects it as an entry of its own.
const isEntry = file => /\.(?:test|spec)\.[^/]*$/.test(file);
const isSupport = file => isEntry(file) || file.split('/').slice(0, -1).some(part => SUPPORT_DIR.test(part));
const CONFIG_FILE = /(?:^|\/)(?:(?:vitest|vite|jest|playwright)\.(?:config|workspace|setup)[^/]*|bunfig\.toml)$/;
const TEST_SCRIPT = /^(?:pre|post)?test(?::|$)/;
const REGULAR = ['100644', '100755'];
const isLocal = specifier => /^[./$#]/.test(specifier);
// The test runner and assertion libraries. A free test reaches them only through test/it/describe and expect
// assertions; a non-test module never reaches them.
const FRAMEWORK = /^(?:vitest|jest|chai|bun:test)(?:\/|$)|^@(?:vitest|jest)\//;
const FRAMEWORK_GLOBALS = new Set(['expect', 'vi', 'vitest', 'jest', 'chai', 'test', 'it', 'describe', 'suite', 'bench',
  'beforeAll', 'beforeEach', 'afterAll', 'afterEach', 'onTestFailed', 'onTestFinished', 'expectTypeOf', 'assertType']);
const REACH = new Set(['expect', 'vi', 'vitest', 'jest', 'chai']);
// Names that reach the global object, the module system or code generation, whatever they are bound to.
const BANNED = new Set(['globalThis', 'global', 'window', 'self', 'frames', 'top', 'parent', 'process', 'Bun', 'Deno',
  'require', 'module', 'exports', 'eval', 'Function', 'Reflect', 'Proxy']);
const BANNED_PROPERTY = /^(?:constructor|prototype|__\w+__)$/;
// The pure builtins a free test may call or name. Any other global (setTimeout, Object.assign, Symbol.for, ...) refuses.
const PURE_MEMBERS = { Object: ['keys', 'values', 'entries', 'fromEntries', 'is'], Array: ['from', 'isArray', 'of'],
  JSON: ['parse', 'stringify'], Math: null, Number: null, String: ['raw', 'fromCharCode'], Date: ['now', 'parse', 'UTC'],
  Promise: ['resolve', 'reject', 'all', 'allSettled', 'race', 'any'], Buffer: ['from', 'isBuffer', 'byteLength', 'concat'] };
const PURE_CONSTRUCTORS = new Set(['Date', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'TypeError', 'RangeError',
  'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError', 'URL', 'URLSearchParams', 'TextEncoder',
  'TextDecoder', 'Uint8Array', 'ArrayBuffer', 'Array', 'RegExp', 'Promise']);
const PURE_FUNCTIONS = new Set(['String', 'Number', 'Boolean', 'BigInt', 'Symbol', 'Date', 'parseInt', 'parseFloat', 'isNaN',
  'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'structuredClone', 'atob', 'btoa']);
const PURE_VALUES = new Set([...PURE_CONSTRUCTORS, ...PURE_FUNCTIONS, 'undefined', 'NaN', 'Infinity', 'JSON', 'Math']);
const EXPECT_STATIC = new Set(['any', 'anything', 'arrayContaining', 'objectContaining', 'stringContaining', 'stringMatching',
  'closeTo', 'assertions', 'hasAssertions']);

// The checker tells which declaration an identifier names (a local, an import, a file declaration or none) for one
// file, with no library and no module resolution. Nothing is run.
const bind = (file, text) => {
  const name = '/' + (/\.(?:[cm]?[jt]sx?)$/.test(file) ? file : `${file}.ts`);
  const tree = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const host = { getSourceFile: requested => (requested === name ? tree : undefined), fileExists: requested => requested === name,
    readFile: () => undefined, getDefaultLibFileName: () => '/lib.d.ts', writeFile: () => {}, getCurrentDirectory: () => '/',
    getCanonicalFileName: requested => requested, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n' };
  const program = ts.createProgram({ rootNames: [name], options: { noLib: true, noResolve: true, allowJs: true, types: [] }, host });
  return { tree, checker: program.getTypeChecker() };
};
const declarationOf = (checker, tree, id) => {
  const symbol = ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
    ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id);
  return symbol?.declarations?.find(declaration => declaration.getSourceFile() === tree);
};
// The module an import binding comes from, or undefined for any other declaration.
const importedFrom = declaration => {
  let node = declaration;
  while (node && !ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node)) node = ts.isSourceFile(node) ? undefined : node.parent;
  if (!node || !(ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)
    || ts.isImportEqualsDeclaration(declaration))) return undefined;
  return ts.isImportDeclaration(node) ? node.moduleSpecifier.text : node.moduleReference.expression?.text ?? '';
};
// An identifier that names a value, not a property, a declaration or a label.
const isReference = id => !((id.parent.name === id && !ts.isShorthandPropertyAssignment(id.parent)) || id.parent.propertyName === id
  || id.parent.label === id || (ts.isQualifiedName(id.parent) && id.parent.right === id));
// Literal module specifiers a file imports, re-exports, requires or loads; a nonliteral one refuses, or is skipped
// when `strict` is false (the module under test, which may load what it likes).
const importsOf = (tree, file, strict = true) => {
  const imports = tree.referencedFiles.map(ref => './' + ref.fileName);
  const nonliteral = () => {
    if (strict) throw Error(`nonliteral protected import: ${file}`);
  };
  (function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) imports.push(node.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (!node.moduleReference.expression || !ts.isStringLiteralLike(node.moduleReference.expression)) nonliteral();
      else imports.push(node.moduleReference.expression.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(tree) === 'require')) {
      if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) nonliteral();
      else imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  })(tree);
  return imports;
};
// The script of a JS/TS module or of a Svelte component's <script> blocks; undefined for other files.
const scriptOf = (file, text) => {
  if (/\.(?:[cm]?[jt]sx?)$/.test(file)) return text;
  if (file.endsWith('.svelte')) return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
  return undefined;
};
// How a module reaches the test framework, if it does: a framework import, require or load, an unbound expect, vi,
// vitest, jest or chai, import.meta.vitest, or the matcher state's registry symbol.
const reachesFramework = (file, text) => {
  const { tree, checker } = bind(file, text);
  let reach;
  (function visit(node) {
    if (reach) return;
    const literal = expression => (expression && ts.isStringLiteralLike(expression) ? expression.text : undefined);
    const call = ts.isCallExpression(node) ? node.expression.getText(tree).replace(/\s/g, '') : undefined;
    const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? literal(node.moduleSpecifier)
      : ts.isImportEqualsDeclaration(node) ? literal(node.moduleReference.expression)
        : call === 'import' || call === 'require' ? literal(node.arguments[0]) : undefined;
    if (specifier !== undefined && FRAMEWORK.test(specifier)) reach = `loads ${specifier}`;
    else if (ts.isMetaProperty(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === 'vitest') reach = 'import.meta.vitest';
    else if (call === 'Symbol.for' && /jest|vitest|chai/i.test(literal(node.arguments[0]) ?? '')) reach = `Symbol.for('${literal(node.arguments[0])}')`;
    else if (ts.isIdentifier(node) && REACH.has(node.text) && isReference(node)) {
      const declaration = declarationOf(checker, tree, node);
      if (!declaration || (importedFrom(declaration) !== undefined && FRAMEWORK.test(importedFrom(declaration)))) reach = `uses ${node.text}`;
    }
    ts.forEachChild(node, visit);
  })(tree);
  return reach;
};

function main() {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const command = separator < 0 ? [] : args.splice(separator).slice(1);
  const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
  const root = realpathSync(options['--root']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  env.LC_ALL = 'C';
  const git = (...words) => execFileSync('git', ['-C', root, ...words], { env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const base = git('rev-parse', '--verify', `${options['--fix-base']}^{commit}`).trim();
  const head = git('rev-parse', 'HEAD').trim();
  if (realpathSync(git('rev-parse', '--show-toplevel').trim()) !== root
      || root !== options['--expected-root'] || head !== options['--expected-head']
      || base !== options['--expected-base']) throw Error('guard repository identity differs from receipt collector');
  if (git('merge-base', base, head).trim() !== base) throw Error('fix base must be an ancestor of HEAD');
  if (git('status', '--porcelain=v1', '--untracked-files=all').trim()) throw Error('fix diff needs a clean tree');
  const findings = JSON.parse(readFileSync(options['--findings'], 'utf8'));
  if (!Array.isArray(findings.tests) || !findings.tests.length) throw Error('findings.tests must be a nonempty list of {file, name}');
  const reasons = findings.assertionCountReasons ?? {};
  const source = (revision, file) => {
    if (file.split('/').some(part => part === 'RAWS' || part === '.local')) throw Error('private dependency cannot be inspected');
    return git('show', `${revision}:${file}`);
  };
  const exists = (revision, file) => spawnSync('git', ['-C', root, 'cat-file', '-e', `${revision}:${file}`], { env }).status === 0;
  const supported = file => /\.(?:[cm]?[jt]sx?)$/.test(file);
  const tokens = text => {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
    const result = [];
    while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) result.push(scanner.getTokenText());
    return JSON.stringify(result);
  };
  const parse = (file, text) => {
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    if (tree.parseDiagnostics.length) throw Error(`cannot parse test file ${file}`);
    const tests = new Map();
    let assertions = 0;
    function visit(node, inactive = false) {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(tree);
        const disabled = inactive || /(?:^|\.)(?:skip|todo|only|skipIf|runIf)(?:\b|$)|^(?:xit|xtest|xdescribe)$/.test(callee);
        if (/^(?:expect|assert)(?:\.|$)/.test(callee)) assertions++;
        if (/^(?:test|it|xit|xtest)(?:\.|$)/.test(callee)) {
          const name = node.arguments[0];
          if (name && ts.isStringLiteralLike(name)) {
            const entries = tests.get(name.text) ?? [];
            let scope = node;
            while (scope.parent && !ts.isSourceFile(scope.parent)) scope = scope.parent;
            entries.push({ inactive: disabled, body: tokens(scope.getText(tree)) });
            tests.set(name.text, entries);
          }
        }
        ts.forEachChild(node, child => visit(child, disabled));
      } else ts.forEachChild(node, child => visit(child, inactive));
    }
    visit(tree);
    return { tests, assertions };
  };
  const before = new Map();
  const after = new Map();
  const load = (cache, revision, file) => {
    if (!supported(file)) throw Error(`unsupported protected test syntax: ${file}; JS/TS required`);
    if (!cache.has(file)) cache.set(file, parse(file, source(revision, file)));
    return cache.get(file);
  };
  // Resolve imports against Git snapshots, never the worker's filesystem or module loader. Only test code is followed.
  const closure = (revision, starts) => {
    const entries = git('ls-tree', '-r', '-z', revision).split('\0').filter(Boolean);
    const modes = new Map(entries.map(entry => [entry.slice(entry.indexOf('\t') + 1), entry.split(' ')[0]]));
    const ids = new Map(entries.map(entry => [entry.slice(entry.indexOf('\t') + 1), entry.split(/[ \t]/)[2]]));
    const files = new Set(modes.keys());
    const resolutionInputs = new Map();
    const reads = new Set();
    const relative = absolute => path.relative(root, absolute).split(path.sep).join('/');
    const host = { fileExists: absolute => files.has(relative(absolute)),
      readFile: absolute => {
        const file = relative(absolute);
        if (!files.has(file)) return undefined;
        if (!REGULAR.includes(modes.get(file))) throw Error(`symlink resolver input refuses: ${file}`);
        const text = source(revision, file);
        resolutionInputs.set(file, text);
        return text;
      }, readDirectory: () => [] };
    let configured = {};
    if (files.has('tsconfig.json')) {
      const config = ts.parseConfigFileTextToJson('tsconfig.json', host.readFile(path.join(root, 'tsconfig.json')));
      if (config.error) throw Error('cannot parse protected resolver configuration');
      const parsed = ts.parseJsonConfigFileContent(config.config, host, root);
      // No inputs does not affect module resolution. SvelteKit's generated .svelte-kit/tsconfig.json is ignored by Git, so
      // neither snapshot has it and the guard never reads the worker's copy; the $lib alias it carries is built in below.
      const errors = parsed.errors.filter(error => error.code !== 18003
        && !(error.code === 5083 && /[/\\]\.svelte-kit[/\\]tsconfig\.json/.test(ts.flattenDiagnosticMessageText(error.messageText, ' '))));
      if (errors.length) throw Error('unsupported or unavailable protected resolver configuration: ' + errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, ' ')).join('; '));
      configured = parsed.options;
    }
    const options = { allowJs: true, resolveJsonModule: true, moduleResolution: ts.ModuleResolutionKind.Bundler,
      baseUrl: root, ...configured, paths: { '$lib/*': ['src/lib/*'], ...(configured.paths ?? {}) } };
    // The tracked file a specifier resolves to from a file, or undefined (a package, or nothing).
    const resolve = (file, specifier) => {
      const resolved = ts.resolveModuleName(specifier, path.join(root, file), options, host).resolvedModule;
      return resolved && files.has(relative(resolved.resolvedFileName)) ? relative(resolved.resolvedFileName) : undefined;
    };
    const found = new Map();
    // The paths a path expression in a file names: a literal, relative to the repository (the runner's directory) and to
    // the file; the __dirname, import.meta.dirname and new URL(..., import.meta.url) forms, relative to the file.
    const where = (tree, file, node) => {
      const folder = path.posix.dirname(file);
      const text = node => node && ts.isStringLiteralLike(node) ? node.text : undefined;
      if (!node) return [];
      const literal = text(node);
      if (literal !== undefined) return [path.posix.normalize(literal), path.posix.normalize(path.posix.join(folder, literal))];
      if (ts.isNewExpression(node) && node.expression.getText(tree) === 'URL' && node.arguments?.length === 2
          && text(node.arguments[0]) !== undefined) return [path.posix.normalize(path.posix.join(folder, text(node.arguments[0])))];
      if (ts.isCallExpression(node) && /(?:^|\.)(?:join|resolve)$/.test(node.expression.getText(tree))) {
        const [first, ...rest] = node.arguments;
        const parts = rest.map(text);
        if (!parts.length || parts.some(part => part === undefined)) return [];
        if (['__dirname', 'import.meta.dirname'].includes(first?.getText(tree))) return [path.posix.normalize(path.posix.join(folder, ...parts))];
        if (text(first) !== undefined) return [path.posix.normalize(path.posix.join(text(first), ...parts))];
      }
      return [];
    };
    // Files a protected file reads by a path expression.
    const literalReads = (tree, file) => {
      const visit = node => {
        if (ts.isCallExpression(node) && /(?:^|\.)(?:readFileSync|readFile|createReadStream|file)$/.test(node.expression.getText(tree))) {
          for (const candidate of where(tree, file, node.arguments[0])) if (files.has(candidate)) reads.add(candidate);
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    };
    function follow(file) {
      if (found.has(file)) return;
      if (!REGULAR.includes(modes.get(file))) throw Error(`symlink/submodule protected dependency refuses: ${file}`);
      if (file.split('/').some(part => part === 'RAWS' || part === '.local')) throw Error('private dependency cannot be inspected');
      const text = source(revision, file);
      found.set(file, text);
      if (!supported(file)) return;
      const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      if (tree.parseDiagnostics.length) throw Error(`cannot parse protected dependency ${file}`);
      literalReads(tree, file);
      for (const specifier of importsOf(tree, file)) {
        const target = resolve(file, specifier);
        if (target) {
          if (isSupport(target)) follow(target); // the module under test is not followed
        } else if (isLocal(specifier)) {
          throw Error(`unresolved local protected import ${specifier} in ${file}`);
        }
      }
    }
    starts.forEach(follow);
    // The runner configuration, every local module it imports (extensionless, .ts, .js or .mjs, through the resolver)
    // and the setup files it names decide whether and how the named tests run. All of it is compared as text.
    const runner = new Set();
    const configure = file => {
      if (runner.has(file)) return;
      runner.add(file);
      if (!REGULAR.includes(modes.get(file))) throw Error(`symlink/submodule protected configuration refuses: ${file}`);
      found.set(file, source(revision, file));
      if (!supported(file)) return;
      const tree = ts.createSourceFile(file, found.get(file), ts.ScriptTarget.Latest, true);
      if (tree.parseDiagnostics.length) throw Error(`cannot parse protected configuration ${file}`);
      for (const specifier of importsOf(tree, file)) {
        const target = resolve(file, specifier);
        if (target) configure(target);
        else if (isLocal(specifier)) throw Error(`unresolved local runner configuration import ${specifier} in ${file}`);
      }
      // setup files: any path expression, and a literal path without its extension, that lands on a module
      (function visit(node) {
        const candidates = where(tree, file, node);
        if (ts.isStringLiteralLike(node) && !/[*?{}\s]/.test(node.text)) {
          const target = resolve(file, /^\.{0,2}\//.test(node.text) ? node.text : `./${node.text}`);
          if (target) candidates.push(target);
        }
        for (const candidate of candidates) if (files.has(candidate) && supported(candidate)) follow(candidate);
        ts.forEachChild(node, visit);
      })(tree);
    };
    [...files].filter(file => CONFIG_FILE.test(file)).forEach(configure);
    if (files.has('package.json')) {
      const scripts = JSON.parse(source(revision, 'package.json')).scripts ?? {};
      found.set('package.json#scripts', JSON.stringify(Object.keys(scripts).filter(name => TEST_SCRIPT.test(name)).sort().map(name => [name, scripts[name]])));
    }
    // A package.json steers resolution only through these fields; a dependency or version edit does not.
    const steering = text => {
      const manifest = JSON.parse(text);
      return JSON.stringify(['name', 'type', 'main', 'module', 'browser', 'imports', 'exports'].map(key => manifest[key] ?? null));
    };
    for (const [file, text] of resolutionInputs) {
      if (path.posix.basename(file) === 'package.json') found.set(`${file}#resolution`, steering(text));
      else if (!found.has(file)) found.set(file, text);
    }
    // Fixtures: files in a fixture directory under a protected test's top-level directory, and files read by literal path.
    const tops = new Set(starts.filter(file => file.includes('/')).map(file => file.split('/')[0]));
    const data = new Set(reads);
    for (const file of files) {
      const parts = file.split('/');
      if (tops.has(parts[0]) && parts.slice(1, -1).some(part => FIXTURE_DIR.test(part))) data.add(file);
    }
    return { found, ids, data, runner, resolve };
  };
  const controlFlow = (file, text) => {
    if (!supported(file)) return [];
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const controls = [];
    function visit(node) {
      if (ts.isReturnStatement(node) || ts.isIfStatement(node) || ts.isConditionalExpression(node)
          || ts.isIterationStatement(node, false) || ts.isSwitchStatement(node)) controls.push(tokens(node.getText(tree)));
      ts.forEachChild(node, visit);
    }
    visit(tree);
    return controls;
  };
  for (const entry of findings.tests) {
    if (!entry || typeof entry.file !== 'string' || typeof entry.name !== 'string' || !entry.name.trim()
        || path.isAbsolute(entry.file) || entry.file.split('/').some(part => part === '..' || part === '.')) {
      throw Error('each protected test requires a repository-relative file and literal name');
    }
    const old = load(before, base, entry.file).tests.get(entry.name) ?? [];
    const current = load(after, head, entry.file).tests.get(entry.name) ?? [];
    if (old.length !== 1 || old[0].inactive) throw Error(`baseline test absent, ambiguous or inactive: ${entry.file}: ${entry.name}`);
    if (current.length !== 1) throw Error(`named test deleted, renamed or ambiguous: ${entry.file}: ${entry.name}`);
    if (current[0].inactive) throw Error(`named test skipped/todo/isolated: ${entry.file}: ${entry.name}`);
    if (old[0].body !== current[0].body) throw Error(`named test changed (assertions may be removed or loosened): ${entry.file}: ${entry.name}`);
  }
  const starts = [...new Set(findings.tests.map(entry => entry.file))];
  const oldClosure = closure(base, starts);
  const currentClosure = closure(head, starts);
  const reasonFor = file => typeof reasons[file] === 'string' && reasons[file].trim();
  // The top-level statements of a protected test file. Free tests are top-level test/it/describe calls that hold no
  // named test.
  const statements = (file, text, names) => {
    const { tree, checker } = bind(file, text);
    const list = tree.statements.map(node => {
      const call = ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) ? node.expression : null;
      let holdsNamed = false;
      (function visit(child) {
        if (ts.isCallExpression(child) && /^(?:test|it|xit|xtest)(?:\.|$)/.test(child.expression.getText(tree))
            && child.arguments[0] && ts.isStringLiteralLike(child.arguments[0]) && names.has(child.arguments[0].text)) holdsNamed = true;
        ts.forEachChild(child, visit);
      })(node);
      const free = Boolean(call) && /^(?:test|it|describe)(?:\.[A-Za-z]+)*$/.test(call.expression.getText(tree)) && !holdsNamed;
      return { node, text: tokens(node.getText(tree)), free, holdsNamed, isImport: ts.isImportDeclaration(node) };
    });
    return { list, tree, checker };
  };
  // What a new or changed free test may hold: test/it/describe registrations with a literal name and a callback (a
  // describe body holds only registrations, since it runs while tests are collected), expect assertions, and plain
  // calls into the module under test or a pure builtin. No vi, no expect.extend or other expect member, no global
  // object, prototype or module system, no assignment, no dynamic import, no hook and no modifier but skip/todo.
  const allowlist = (file, tree, checker) => statement => {
    const refuse = (node, why) => {
      const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
      throw Error(`free test outside the allowlist at ${file}:${line} (${why}); a free test may hold only test/it/describe registrations, expect assertions and plain calls into the module under test, and a recorded reason cannot excuse more`);
    };
    const binding = id => {
      const declaration = declarationOf(checker, tree, id);
      if (!declaration) return { kind: 'unbound' };
      if (declaration.pos >= statement.pos && declaration.end <= statement.end) return { kind: 'local' };
      const from = importedFrom(declaration);
      if (from === undefined) return { kind: 'file' };
      if (!FRAMEWORK.test(from)) return { kind: 'import' };
      return { kind: 'framework', name: ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : undefined };
    };
    const isExpect = id => {
      if (!ts.isIdentifier(id)) return false;
      const found = binding(id);
      return found.kind === 'unbound' ? id.text === 'expect' : found.kind === 'framework' && found.name === 'expect';
    };
    // Framework names refuse whatever they are bound to: Vitest hoists vi.mock by name, wherever vi comes from.
    const named = id => {
      if (BANNED.has(id.text)) refuse(id, `${id.text} reaches the global object or the module system`);
      const found = binding(id);
      if (found.kind === 'framework' || FRAMEWORK_GLOBALS.has(id.text)) refuse(id, `${id.text} outside a registration or an expect assertion`);
      return found;
    };
    const reference = id => {
      const found = named(id);
      if (found.kind === 'unbound' && id.text in globalThis && !PURE_VALUES.has(id.text)) refuse(id, `global ${id.text}`);
    };
    const property = (node, name) => {
      if (BANNED_PROPERTY.test(name)) refuse(node, `property ${name}`);
    };
    const callee = (node, constructor) => {
      const members = [];
      let target = node;
      while (ts.isPropertyAccessExpression(target)) {
        property(target.name, target.name.text);
        members.unshift(target.name.text);
        target = target.expression;
      }
      if (!ts.isIdentifier(target)) return walk(target);
      const found = named(target);
      if (found.kind !== 'unbound' || !(target.text in globalThis)) return;
      const pure = members.length === 0 ? (constructor ? PURE_CONSTRUCTORS : PURE_FUNCTIONS).has(target.text)
        : members.length === 1 && target.text in PURE_MEMBERS && (PURE_MEMBERS[target.text] ?? [members[0]]).includes(members[0]);
      if (!pure) refuse(node, `call to global ${[target.text, ...members].join('.')}`);
    };
    // expect(x) or expect.soft(x), then .not, .resolves or .rejects, then one .toXxx(...) matcher
    const assertion = node => {
      if (!ts.isPropertyAccessExpression(node.expression) || !/^to[A-Z]\w*$/.test(node.expression.name.text)) return false;
      let target = node.expression.expression;
      while (ts.isPropertyAccessExpression(target) && ['not', 'resolves', 'rejects'].includes(target.name.text)) target = target.expression;
      if (!ts.isCallExpression(target)) return false;
      const root = ts.isPropertyAccessExpression(target.expression) && target.expression.name.text === 'soft' ? target.expression.expression : target.expression;
      if (!isExpect(root)) return false;
      target.arguments.forEach(walk);
      node.arguments.forEach(walk);
      return true;
    };
    // expect.any(...), expect.objectContaining(...), expect.not.stringContaining(...), expect.assertions(n), ...
    const expectMember = node => {
      if (!ts.isPropertyAccessExpression(node.expression) || !EXPECT_STATIC.has(node.expression.name.text)) return false;
      let target = node.expression.expression;
      if (ts.isPropertyAccessExpression(target) && target.name.text === 'not') target = target.expression;
      if (!isExpect(target)) return false;
      node.arguments.forEach(walk);
      return true;
    };
    const declare = name => {
      if (ts.isIdentifier(name)) return;
      for (const element of name.elements) {
        if (ts.isOmittedExpression(element)) continue;
        if (element.propertyName && ts.isComputedPropertyName(element.propertyName)) walk(element.propertyName.expression);
        if (element.initializer) walk(element.initializer);
        declare(element.name);
      }
    };
    const PASS = new Set([ts.SyntaxKind.Block, ts.SyntaxKind.ExpressionStatement, ts.SyntaxKind.VariableStatement,
      ts.SyntaxKind.ReturnStatement, ts.SyntaxKind.IfStatement, ts.SyntaxKind.EmptyStatement, ts.SyntaxKind.ThrowStatement,
      ts.SyntaxKind.TryStatement, ts.SyntaxKind.ParenthesizedExpression, ts.SyntaxKind.AwaitExpression,
      ts.SyntaxKind.ConditionalExpression, ts.SyntaxKind.ArrayLiteralExpression, ts.SyntaxKind.ObjectLiteralExpression,
      ts.SyntaxKind.SpreadElement, ts.SyntaxKind.SpreadAssignment, ts.SyntaxKind.TemplateExpression, ts.SyntaxKind.TemplateSpan,
      ts.SyntaxKind.AsExpression, ts.SyntaxKind.SatisfiesExpression, ts.SyntaxKind.NonNullExpression,
      ts.SyntaxKind.TypeAssertionExpression, ts.SyntaxKind.TypeOfExpression, ts.SyntaxKind.VoidExpression,
      ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.BigIntLiteral,
      ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.RegularExpressionLiteral, ts.SyntaxKind.TemplateHead,
      ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword,
      ts.SyntaxKind.NullKeyword, ts.SyntaxKind.AsyncKeyword]);
    function walk(node) {
      if (ts.isTypeNode(node)) return; // types have no runtime effect
      if (node.kind >= ts.SyntaxKind.FirstPunctuation && node.kind <= ts.SyntaxKind.LastPunctuation) return;
      if (ts.isIdentifier(node)) return reference(node);
      if (ts.isPropertyAccessExpression(node)) {
        property(node.name, node.name.text);
        return walk(node.expression);
      }
      if (ts.isElementAccessExpression(node)) {
        const key = node.argumentExpression;
        if (!ts.isNumericLiteral(key) && !ts.isStringLiteralLike(key)) refuse(node, 'computed member access');
        if (ts.isStringLiteralLike(key)) property(key, key.text);
        return walk(node.expression);
      }
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) refuse(node, 'dynamic import');
        if (assertion(node) || expectMember(node)) return;
        callee(node.expression, false);
        return node.arguments.forEach(walk);
      }
      if (ts.isNewExpression(node)) {
        callee(node.expression, true);
        return (node.arguments ?? []).forEach(walk);
      }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        if (node.asteriskToken) refuse(node, 'generator');
        for (const parameter of node.parameters) {
          if (parameter.initializer) walk(parameter.initializer);
          declare(parameter.name);
        }
        return walk(node.body);
      }
      if (ts.isVariableDeclarationList(node)) {
        for (const declaration of node.declarations) {
          if (declaration.initializer) walk(declaration.initializer);
          declare(declaration.name);
        }
        return;
      }
      if (ts.isForOfStatement(node)) {
        if (!ts.isVariableDeclarationList(node.initializer)) refuse(node, 'for-of over an existing binding');
        walk(node.initializer);
        walk(node.expression);
        return walk(node.statement);
      }
      if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        if (ts.isComputedPropertyName(node.name)) walk(node.name.expression);
        else property(node.name, node.name.text);
        return ts.isShorthandPropertyAssignment(node) ? reference(node.name) : walk(node.initializer);
      }
      if (ts.isBinaryExpression(node)) {
        const operator = node.operatorToken.kind;
        if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) refuse(node, 'assignment');
        walk(node.left);
        return walk(node.right);
      }
      if (ts.isCatchClause(node)) {
        if (node.variableDeclaration) declare(node.variableDeclaration.name);
        return walk(node.block);
      }
      if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) refuse(node, 'update');
      if (!PASS.has(node.kind) && !ts.isPrefixUnaryExpression(node)) refuse(node, ts.SyntaxKind[node.kind]);
      ts.forEachChild(node, walk);
    }
    const registration = node => {
      const call = ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) ? node.expression : undefined;
      const form = call && /^(test|it|describe)(?:\.(skip|todo))?$/.exec(call.expression.getText(tree));
      if (!form) return refuse(node, 'not a test/it/describe registration');
      const root = ts.isIdentifier(call.expression) ? call.expression : call.expression.expression;
      // the runner's own test/it/describe: a file-level function of that name could run the callback at collection
      if (!['unbound', 'framework'].includes(binding(root).kind)) refuse(root, `${root.text} is not the test runner`);
      const [name, callback, timeout, ...rest] = call.arguments;
      if (!name || !ts.isStringLiteralLike(name) || rest.length) refuse(call, 'a registration takes a literal name, a callback and a numeric timeout');
      if (form[2] === 'todo' && !callback) return;
      if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || callback.parameters.length || callback.asteriskToken) {
        refuse(call, 'a registration callback is a function without parameters');
      }
      if (timeout && !ts.isNumericLiteral(timeout)) refuse(timeout, 'only a numeric timeout may follow the callback');
      if (form[1] !== 'describe') return walk(callback.body);
      if (!ts.isBlock(callback.body)) refuse(callback, 'a describe body is a block');
      callback.body.statements.forEach(registration);
    };
    return registration(statement);
  };
  for (const file of starts) {
    const names = new Set(findings.tests.filter(entry => entry.file === file).map(entry => entry.name));
    const reviewed = statements(file, oldClosure.found.get(file), names).list;
    const { list: current, tree, checker } = statements(file, currentClosure.found.get(file), names);
    const seen = new Set(reviewed.map(statement => statement.text));
    const fixed = list => JSON.stringify(list.filter(statement => !statement.free).map(statement => statement.text));
    if (fixed(reviewed) !== fixed(current.filter(statement => !(statement.isImport && !seen.has(statement.text))))) {
      throw Error(`protected test file changed outside its free tests (imports, helpers, mocks, hooks and the named tests stay as reviewed): ${file}`);
    }
    // Tests in a file run in order, so nothing may change up to the last named test: a free test placed, changed or
    // dropped before it could set or clear state the named test reads.
    const prefix = list => JSON.stringify(list.slice(0, list.findLastIndex(statement => statement.holdsNamed) + 1)
      .filter(statement => !statement.isImport).map(statement => statement.text));
    if (prefix(reviewed) !== prefix(current)) {
      throw Error(`protected test file changed before its last named test (free tests may change only after it): ${file}`);
    }
    const added = current.filter(statement => !seen.has(statement.text));
    const free = list => JSON.stringify(list.filter(statement => statement.free).map(statement => statement.text));
    if (free(reviewed) === free(current) && !added.some(statement => statement.isImport)) continue;
    if (!reasonFor(file)) throw Error(`protected dependency changed: ${file}; a free test change or a new import needs explicit assertion count reasons in assertionCountReasons[file]`);
    // A new import loads nothing the reviewed file did not: it names a module the file already imports, a protected
    // helper, or an unchanged module under test that never reaches the test framework. A side-effect import refuses.
    const target = (resolved, file, specifier) => {
      const found = resolved(file, specifier);
      if (!found && isLocal(specifier)) throw Error(`unresolved local protected import ${specifier} in ${file}`);
      return found ?? `package:${specifier}`;
    };
    const imported = new Set(reviewed.filter(statement => statement.isImport)
      .map(statement => target(oldClosure.resolve, file, statement.node.moduleSpecifier.text)));
    const clean = (module, visited) => {
      if (visited.has(module)) return;
      visited.add(module);
      const script = scriptOf(module, source(head, module));
      if (script === undefined) return;
      const reach = reachesFramework(module, script);
      if (reach) throw Error(`new import in ${file} loads ${module}, which reaches the test framework (${reach})`);
      for (const specifier of importsOf(ts.createSourceFile(module, script, ts.ScriptTarget.Latest, true), module)) {
        const next = currentClosure.resolve(module, specifier);
        if (next) clean(next, visited);
        else if (isLocal(specifier)) throw Error(`new import in ${file} loads ${module}, whose local import ${specifier} cannot be inspected`);
      }
    };
    for (const statement of added) {
      if (!statement.isImport) {
        allowlist(file, tree, checker)(statement.node);
        continue;
      }
      const specifier = statement.node.moduleSpecifier.text;
      if (!statement.node.importClause) throw Error(`new side-effect import ${specifier} in ${file}; a recorded reason cannot excuse it`);
      if (statement.node.importClause.isTypeOnly) continue;
      const module = target(currentClosure.resolve, file, specifier);
      if (imported.has(module) || oldClosure.found.has(module)) continue;
      if (module.startsWith('package:') || isSupport(module) || !exists(base, module)
          || oldClosure.ids.get(module) !== currentClosure.ids.get(module)) {
        throw Error(`new import ${specifier} in ${file} must name a module the reviewed file imports, a protected helper or an unchanged module under test`);
      }
      clean(module, new Set());
    }
  }
  // Everything else in the closure (helpers, fixtures, resolver and runner configuration, setup files, test scripts)
  // stays as reviewed. No reason excuses a change there.
  for (const file of new Set([...oldClosure.found.keys(), ...currentClosure.found.keys()])) {
    if (starts.includes(file)) continue;
    const oldText = oldClosure.found.get(file);
    const newText = currentClosure.found.get(file);
    if (oldText === undefined || newText === undefined) throw Error(`protected dependency added/deleted: ${file}`);
    if (tokens(oldText) === tokens(newText)) continue;
    if (JSON.stringify(controlFlow(file, oldText)) !== JSON.stringify(controlFlow(file, newText))) {
      throw Error(`protected dependency control flow changed (return/conditional/wrapping): ${file}`);
    }
    throw Error(`protected dependency changed: ${file}; a recorded reason cannot excuse a helper, fixture, configuration or setup change`);
  }
  for (const file of oldClosure.data) {
    if (currentClosure.ids.get(file) !== oldClosure.ids.get(file)) throw Error(`protected fixture changed or deleted: ${file}`);
  }
  const changed = git('diff', '--name-only', '-z', base, head).split('\0').filter(Boolean);
  // A fix may change the module under test freely, but a matcher, spy or global installed from code the named test
  // loads changes what every test proves. Any changed module outside the protected closure and the runner can be
  // loaded that way, the module under test and the test-support files it loads alike, so none may reach the test
  // framework, and none may newly load a test file or support code that does. Test files are collected as entries of
  // their own, so they are left to the assertion count below.
  const compared = new Set([...oldClosure.found.keys(), ...currentClosure.found.keys()]);
  const walked = new Set();
  const loadsSupport = (from, module) => {
    if (walked.has(module) || !isSupport(module)) return; // the module under test is not followed
    if (isEntry(module)) throw Error(`changed module ${from} newly loads the test file ${module}`);
    walked.add(module);
    const script = scriptOf(module, source(head, module));
    if (script === undefined) return;
    const reach = reachesFramework(module, script);
    if (reach) throw Error(`changed module ${from} newly loads ${module}, which reaches the test framework (${reach})`);
    for (const specifier of importsOf(ts.createSourceFile(module, script, ts.ScriptTarget.Latest, true), module)) {
      const next = currentClosure.resolve(module, specifier);
      if (next) loadsSupport(from, next);
      else if (isLocal(specifier)) throw Error(`changed module ${from} newly loads ${module}, whose local import ${specifier} cannot be inspected`);
    }
  };
  const loads = (revision, resolve, file) => {
    const script = exists(revision, file) ? scriptOf(file, source(revision, file)) : undefined;
    if (script === undefined) return new Set();
    const tree = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true);
    return new Set(importsOf(tree, file, false).map(specifier => resolve(file, specifier)).filter(Boolean));
  };
  for (const file of changed) {
    if (isEntry(file) || compared.has(file) || CONFIG_FILE.test(file) || oldClosure.runner.has(file)
        || currentClosure.runner.has(file) || !exists(head, file)) continue;
    const script = scriptOf(file, source(head, file));
    const reach = script === undefined ? undefined : reachesFramework(file, script);
    if (reach) throw Error(`changed module outside the protected closure reaches the test framework (${reach}): ${file}`);
    const reviewed = loads(base, oldClosure.resolve, file);
    for (const target of loads(head, currentClosure.resolve, file)) if (!reviewed.has(target)) loadsSupport(file, target);
  }
  for (const file of changed) {
    if (!(/(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\./.test(file))) continue;
    if (!supported(file)) {
      if (/\.(?:py|sh)$/.test(file)) throw Error(`unsupported changed test syntax: ${file}; guard refuses to infer assertion counts`);
      continue;
    }
    const old = exists(base, file) ? load(before, base, file).assertions : 0;
    const current = exists(head, file) ? load(after, head, file).assertions : 0;
    if (current < old && !(typeof reasons[file] === 'string' && reasons[file].trim())) {
      throw Error(`assertion count fell in ${file}: ${old} -> ${current}; record assertionCountReasons[file]`);
    }
  }
  console.log(`test-guard: PASS (${findings.tests.length} named tests; ${base}..${head})`);
  if (command.length) {
    const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit', cwd: root, env });
    if (result.error) throw result.error;
    return result.status ?? 1;
  }
  return 0;
}
try { process.exitCode = main(); }
catch (error) { console.error(`test-guard: FAIL. ${error.message}`); process.exitCode = 1; }
