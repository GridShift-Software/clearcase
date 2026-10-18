// Conservative protection: a named callback must retain every executable token.
// The TypeScript parser handles JS/TS syntax without running tests or loading their imports.
import ts from 'typescript';
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

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
  // Resolve imports against Git snapshots, never the worker's filesystem or module loader.
  const closure = (revision, starts) => {
    const entries = git('ls-tree', '-r', '-z', revision).split('\0').filter(Boolean);
    const modes = new Map(entries.map(entry => [entry.slice(entry.indexOf('\t') + 1), entry.split(' ')[0]]));
    const files = new Set(modes.keys());
    const resolutionInputs = new Map();
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
      const errors = parsed.errors.filter(error => error.code !== 18003); // no-inputs does not affect module resolution
      if (errors.length) throw Error('unsupported or unavailable protected resolver configuration: ' + errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, ' ')).join('; '));
      configured = parsed.options;
    }
    const options = { allowJs: true, resolveJsonModule: true, moduleResolution: ts.ModuleResolutionKind.Bundler,
      baseUrl: root, ...configured, paths: { '$lib/*': ['src/lib/*'], ...(configured.paths ?? {}) } };
    const found = new Map();
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
      for (const specifier of imports) {
        const resolved = ts.resolveModuleName(specifier, path.join(root, file), options, host).resolvedModule;
        if (resolved && files.has(relative(resolved.resolvedFileName))) follow(relative(resolved.resolvedFileName));
        else if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('$') || specifier.startsWith('#')) {
          throw Error(`unresolved local protected import ${specifier} in ${file}`);
        }
      }
    }
    starts.forEach(follow);
    for (const [file, text] of resolutionInputs) if (!found.has(file)) found.set(file, text);
    return found;
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
  const starts = findings.tests.map(entry => entry.file);
  const oldClosure = closure(base, starts);
  const currentClosure = closure(head, starts);
  for (const file of new Set([...oldClosure.keys(), ...currentClosure.keys()])) {
    const oldText = oldClosure.get(file);
    const newText = currentClosure.get(file);
    if (oldText === undefined || newText === undefined) throw Error(`protected dependency added/deleted: ${file}`);
    if (tokens(oldText) === tokens(newText)) continue;
    if (!(typeof reasons[file] === 'string' && reasons[file].trim())) {
      throw Error(`protected dependency changed: ${file}; explicit assertion count reasons required in assertionCountReasons[file]`);
    }
    if (JSON.stringify(controlFlow(file, oldText)) !== JSON.stringify(controlFlow(file, newText))) {
      throw Error(`protected dependency control flow changed (return/conditional/wrapping): ${file}`);
    }
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
