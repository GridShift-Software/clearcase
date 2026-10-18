// Conservative protection: a named callback must retain every executable token.
// The TypeScript parser handles JS/TS syntax without running tests or loading their imports.
// Protected: the named tests; the test code they import (files under test-support directories); the runner
// configuration, setup files and test scripts; and the fixtures they read or that sit in the test tree. The modules
// under test (src/, scripts/) are not protected: a fix is expected to change them.
import ts from 'typescript';
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const SUPPORT_DIR = /^(?:tests?|__tests__|e2e|support|test-?utils?|test-?helpers?|fixtures?|__fixtures__|__mocks__|__snapshots__)$/;
const FIXTURE_DIR = /^(?:fixtures?|__fixtures__|__mocks__|__snapshots__)$/;
const isSupport = file => /\.(?:test|spec)\.[^/]*$/.test(file) || file.split('/').slice(0, -1).some(part => SUPPORT_DIR.test(part));
const CONFIG_FILE = /(?:^|\/)(?:(?:vitest|vite|jest|playwright)\.(?:config|workspace|setup)[^/]*|bunfig\.toml)$/;
const TEST_SCRIPT = /^(?:pre|post)?test(?::|$)/;
// Test code that changes what runs for every test in the file, or that stands in for a module.
const INSTALLS = /\b(?:vi|jest)\s*\.\s*(?:mock|doMock|hoisted|stubGlobal|stubEnv|setConfig|resetModules|unmock)\b|\.only\b|\b(?:fit|fdescribe)\s*\(/;

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
        if (!['100644', '100755'].includes(modes.get(file))) throw Error(`symlink resolver input refuses: ${file}`);
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
    const found = new Map();
    // Files a protected file reads by a literal path: relative to the repository (the runner's directory) and, for the
    // __dirname, import.meta.dirname and new URL(..., import.meta.url) forms, to the file.
    const literalReads = (tree, file) => {
      const folder = path.posix.dirname(file);
      const text = node => node && ts.isStringLiteralLike(node) ? node.text : undefined;
      const where = node => {
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
      const visit = node => {
        if (ts.isCallExpression(node) && /(?:^|\.)(?:readFileSync|readFile|createReadStream|file)$/.test(node.expression.getText(tree))) {
          for (const candidate of where(node.arguments[0])) if (files.has(candidate)) reads.add(candidate);
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    };
    function follow(file) {
      if (found.has(file)) return;
      if (!['100644', '100755'].includes(modes.get(file))) throw Error(`symlink/submodule protected dependency refuses: ${file}`);
      if (file.split('/').some(part => part === 'RAWS' || part === '.local')) throw Error('private dependency cannot be inspected');
      const text = source(revision, file);
      found.set(file, text);
      if (!supported(file)) return;
      const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      if (tree.parseDiagnostics.length) throw Error(`cannot parse protected dependency ${file}`);
      const imports = tree.referencedFiles.map(ref => './' + ref.fileName);
      function visit(node) {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) imports.push(node.moduleSpecifier.text);
        if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
          if (!node.moduleReference.expression || !ts.isStringLiteralLike(node.moduleReference.expression)) throw Error(`nonliteral protected import: ${file}`);
          imports.push(node.moduleReference.expression.text);
        }
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(tree) === 'require')) {
          if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) throw Error(`nonliteral protected import: ${file}`);
          imports.push(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
      }
      visit(tree);
      literalReads(tree, file);
      for (const specifier of imports) {
        const resolved = ts.resolveModuleName(specifier, path.join(root, file), options, host).resolvedModule;
        const target = resolved && files.has(relative(resolved.resolvedFileName)) ? relative(resolved.resolvedFileName) : undefined;
        if (target) {
          if (isSupport(target)) follow(target); // the module under test is not followed
        } else if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('$') || specifier.startsWith('#')) {
          throw Error(`unresolved local protected import ${specifier} in ${file}`);
        }
      }
    }
    starts.forEach(follow);
    // The runner configuration and the setup files it names decide whether and how the named tests run.
    for (const config of [...files].filter(file => CONFIG_FILE.test(file))) {
      if (!['100644', '100755'].includes(modes.get(config))) throw Error(`symlink/submodule protected configuration refuses: ${config}`);
      found.set(config, source(revision, config)); // its imports are tooling, not test code: compared as text only
      if (!supported(config)) continue;
      const named = [];
      (function visit(node) {
        if (ts.isStringLiteralLike(node)) named.push(node.text);
        ts.forEachChild(node, visit);
      })(ts.createSourceFile(config, found.get(config), ts.ScriptTarget.Latest, true));
      for (const literal of named) {
        for (const candidate of [path.posix.normalize(literal), path.posix.normalize(path.posix.join(path.posix.dirname(config), literal))]) {
          if (files.has(candidate) && supported(candidate)) follow(candidate);
        }
      }
    }
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
    return { found, ids, data };
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
  // A protected test file keeps everything but its free tests (other tests that hold no named test) as reviewed.
  // A recorded reason lets free tests change, and no more: no mock, hook, stub or isolation can arrive with it.
  const statements = (file, text, names) => {
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    return tree.statements.map(node => {
      const call = ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) ? node.expression : null;
      let holdsNamed = false;
      (function visit(child) {
        if (ts.isCallExpression(child) && /^(?:test|it|xit|xtest)(?:\.|$)/.test(child.expression.getText(tree))
            && child.arguments[0] && ts.isStringLiteralLike(child.arguments[0]) && names.has(child.arguments[0].text)) holdsNamed = true;
        ts.forEachChild(child, visit);
      })(node);
      const free = Boolean(call) && /^(?:test|it|describe)(?:\.[A-Za-z]+)*$/.test(call.expression.getText(tree)) && !holdsNamed;
      return { text: tokens(node.getText(tree)), source: node.getText(tree), free, isImport: ts.isImportDeclaration(node) };
    });
  };
  for (const file of starts) {
    const names = new Set(findings.tests.filter(entry => entry.file === file).map(entry => entry.name));
    const reviewed = statements(file, oldClosure.found.get(file), names);
    const current = statements(file, currentClosure.found.get(file), names);
    const seen = new Set(reviewed.map(statement => statement.text));
    const fixed = list => JSON.stringify(list.filter(statement => !statement.free).map(statement => statement.text));
    if (fixed(reviewed) !== fixed(current.filter(statement => !(statement.isImport && !seen.has(statement.text))))) {
      throw Error(`protected test file changed outside its free tests (imports, helpers, mocks, hooks and the named tests stay as reviewed): ${file}`);
    }
    const free = list => JSON.stringify(list.filter(statement => statement.free).map(statement => statement.text));
    if (free(reviewed) === free(current)) continue;
    if (!reasonFor(file)) throw Error(`protected dependency changed: ${file}; explicit assertion count reasons required in assertionCountReasons[file]`);
    for (const statement of current) {
      if (statement.free && !seen.has(statement.text) && INSTALLS.test(statement.source)) {
        throw Error(`added test code installs a mock or isolation in ${file}; a recorded reason cannot excuse it`);
      }
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
  for (const file of changed) {
    if (!(/(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\./.test(file))) continue;
    if (!supported(file)) {
      if (/\.(?:py|sh)$/.test(file)) throw Error(`unsupported changed test syntax: ${file}; guard refuses to infer assertion counts`);
      continue;
    }
    const exists = revision => spawnSync('git', ['-C', root, 'cat-file', '-e', `${revision}:${file}`], { env }).status === 0;
    const old = exists(base) ? load(before, base, file).assertions : 0;
    const current = exists(head) ? load(after, head, file).assertions : 0;
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
