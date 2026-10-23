// Conservative protection: a named callback must retain every executable token.
// The TypeScript parser handles JS/TS syntax without running tests or loading their imports.
// Protected: the named tests; the test code they import (files under test-support directories); the runner
// configuration, the local modules it imports, its setup files and test scripts; and the fixtures they read or that sit
// in the test tree. The modules under test (src/, scripts/) are not protected: a fix is expected to change them, but no
// changed module outside that closure, test-support files included, may reach the test framework or newly load test
// code that does, and a new import into a protected test file may add no import-time effect.
import ts from 'typescript';
import { compile, parse } from 'svelte/compiler';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { builtinModules, createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SUPPORT_DIR = /^(?:tests?|__tests__|e2e|support|test-?utils?|test-?helpers?|fixtures?|__fixtures__|__mocks__|__snapshots__)$/;
const FIXTURE_DIR = /^(?:fixtures?|__fixtures__|__mocks__|__snapshots__)$/;
// A test file: the runner collects it as an entry of its own.
const isEntry = file => /\.(?:test|spec)\.[^/]*$/.test(file);
const isSupport = file => isEntry(file) || file.split('/').slice(0, -1).some(part => SUPPORT_DIR.test(part));
// Documentation for a docs-only fix round: a .md file no directory of which holds code, served files, build output or
// tests. Anything else fails closed.
const CODE_DIR = /^(?:src|scripts|static|build|node_modules|\.svelte-kit|RAWS|\.local)$/;
const isDocument = file => file.endsWith('.md') && file.split('/').slice(0, -1).every(part => !CODE_DIR.test(part) && !SUPPORT_DIR.test(part));
// Markdown documentation that tracked code or a test reads, as an input or an expected value: that check's input, so a
// docs-only declaration that changes one is refused. An entry ending in / covers every file under it. ReadDocuments in
// tests/agent-tools/test_docs_only.py fails when markdownReads() finds a read at HEAD that no entry covers; the base's
// copy of the list judges a pull request.
const READ_DOCUMENTS = [
  '.agents/skills/verify-clearcase/features/', // lib/features.mjs reads each feature and checks its sections
  '.agents/skills/verify-clearcase-hosted/features/', // lib/features.mjs: each driven step's feature must name it
  'docs/acceptance/CC-11/defects-table.md', // scripts/verify/evidence.sh passes it to dispositions.mjs --md
  'docs/acceptance/CC-11/matrix.md', // scripts/verify/matrix.mjs builds it as its default output
  'docs/acceptance/hosting/deployment.md', // deploy/probes/summary-check.ts and tests/hosting-probe/deployment/probe.ts
  'docs/ci-runner.md', // tests/ci/workflow-admission.test.ts, tests/ci/pc1-vm-verify.test.ts
  'docs/compatibility.md', // tests/case-package/compat/probe.ts reads its compat-inventory block
  'docs/delivery-plan.md', // scripts/planning/plan_format.py and generate.py, agent-tools verify plan-format
  'docs/plan/program-intro.md', // scripts/planning/generate.py and plan_format.py
  'docs/plan/tickets/', // scripts/planning/generate.py compares each brief with the one it generates
  'docs/reference/audit-dispositions.md', // tests/e2e/pilot/v5/lanes.mjs (verify:pilot:v5)
  'docs/reference/defects.md', // scripts/verify/lib/defects.mjs, tests/parity/register-dispositions.test.ts
  'docs/reference/parity/', // scripts/verify/dispositions.mjs and the register test read files there by computed name
  'docs/reference/view-checklist.md', // scripts/verify/matrix.mjs and lib/defects.mjs, scripts/fixtures/count_actions.py
  'docs/results-package.md', // tests/case-package/docs.test.ts and newer-analysis.test.ts
  'README.md', // conservative generic-call classification of commit() in tests/hosting-probe/identity/check.test.ts
];
const listed = file => READ_DOCUMENTS.some(entry => file === entry || entry.endsWith('/') && file.startsWith(entry));

// Where tracked code at a revision reads Markdown documentation: [{ reader, line, document }], each document a file or
// a directory ending in /. A read is a path that reaches a file-read call, an import, a call that takes it as a path
// rather than as text (a fixture loader), a path built with join, resolve or new URL, or a word of a shell command. A
// comment, printed text, a message, an assertion's expected text, a write, an existence test and a copy are not: a copy
// only moves files, and the code that reads the copy is scanned where it reads. Ambiguity fails closed: a path computed
// under a directory that holds documentation reads that directory, and a read of a file name under an unknown directory
// (a copy, a temporary tree) reads every document of that name. A path with no static directory (a walk of every file,
// as check-links makes) or with another extension is not a read of documentation.
const UNKNOWN = '\0';
const HERE = '\u0001';
const JS_READ = new Set(['readFileSync', 'readFile', 'createReadStream', 'readdirSync', 'readdir', 'opendirSync', 'opendir',
  'globSync', 'glob', 'require']);
const JS_DIRECTORY = new Set(['readdirSync', 'readdir', 'opendirSync', 'opendir', 'globSync', 'glob']);
// calls that take a path to write, test, move or copy, not to read: the paths built for them are not reads
const JS_WRITE = /^(?:write|writeSync|writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|symlink|symlinkSync|chmod|chmodSync|existsSync|statSync|stat|lstatSync|access|accessSync|cp|cpSync|copyFile|copyFileSync)$/;
const JS_TEXT = /^(?:log|warn|error|info|debug|trace|push|unshift|includes|toContain|toMatch|toBe|toEqual|toStrictEqual|toThrow|expect|assert|match|matchAll|equal|strictEqual|deepEqual|notEqual|ok|test|it|describe|exec|startsWith|endsWith|replace|replaceAll|split|indexOf|lastIndexOf|join|concat|has|get|set|add|delete|Error|TypeError|RangeError|fail|problem|refuse|relative|basename|extname|dirname)$/;
const PY_READ = /\bopen\s*\(|\.read_(?:text|bytes)\s*\(|\.r?glob\s*\(|\.iterdir\s*\(|\b(?:listdir|walk|scandir)\s*\(/;
const PY_DIRECTORY = /\.r?glob\s*\(|\.iterdir\s*\(|\b(?:listdir|walk|scandir)\s*\(/;
const PY_WRITE = /\.(?:is_file|is_dir|exists|mkdir|write_text|write_bytes|unlink|touch|chmod|rename|replace|symlink_to)\s*\(|\b(?:shutil\.\w+|os\.(?:path\.(?:exists|isfile|isdir)|remove|unlink|makedirs|mkdir|rename))\s*\(/;
// shell commands that print, write, test, move or copy, and workflow keys that hold no command
const SH_TEXT = new Set(['echo', 'printf', 'die', 'hold', 'fail', 'log', 'info', 'warn', 'note', 'ok', 'bad', 'say', 'reason_has',
  'mkdir', 'rm', 'rmdir', 'touch', 'chmod', 'chown', 'ln', 'cp', 'mv', 'rsync', 'install', 'cd', 'pushd', 'popd', 'export',
  'local', 'declare', 'readonly', 'unset', 'trap', 'return', 'exit', 'true', 'false', ':', 'mktemp', 'test', '[', '[[',
  'shift', 'set', 'wait', 'kill', 'sleep', 'name:', 'if:', 'with:', 'uses:', 'env:']);
const SH_PREFIX = new Set(['sudo', 'env', 'exec', 'command', 'time', 'nohup', 'setsid', 'then', 'do', 'else', 'elif', 'if',
  'while', 'until', '!', '-', 'run:']);
const SH_ROOT = /^(?:REPO|ROOT|WT|TOP|REPO_ROOT|GITHUB_WORKSPACE)$/;
const dollars = word => word.replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*|\$\d|\*+|\?/g, UNKNOWN);

// A Python file's lines: the code with each string blanked to "" and the comment cut, and the strings in order (an
// f-string's fields unknown). Triple-quoted strings are text.
const pythonLines = text => {
  let triple = null;
  return text.split('\n').map(raw => {
    let blank = '';
    const strings = [];
    for (let i = 0; i < raw.length;) {
      if (triple) {
        const end = raw.indexOf(triple, i);
        if (end < 0) break;
        [i, triple, blank] = [end + 3, null, `${blank}""`];
        strings.push('');
        continue;
      }
      const c = raw[i];
      if (c === '#') break;
      if (c !== '"' && c !== "'") { blank += c; i++; continue; }
      if (raw.startsWith(c.repeat(3), i)) { [triple, i] = [c.repeat(3), i + 3]; continue; }
      const formatted = /(?:^|[^\w])[rRbB]?[fF][rRbB]?$/.test(raw.slice(0, i));
      let j = i + 1;
      let value = '';
      while (j < raw.length && raw[j] !== c) value += raw[j] === '\\' ? raw[(j += 2) - 1] ?? '' : raw[j++];
      strings.push(formatted ? value.replace(/\{[^}]*\}/g, UNKNOWN) : value);
      [blank, i] = [`${blank}""`, j + 1];
    }
    return { blank, strings };
  });
};

// A shell script's (or a workflow's) commands: [{ line, words }], quotes removed, comments and here-documents left out.
const shellCommands = text => {
  const commands = [];
  let heredoc = null;
  text.split('\n').forEach((raw, n) => {
    if (heredoc) {
      if (raw.trim() === heredoc) heredoc = null;
      return;
    }
    let words = [];
    let word = '';
    let started = false;
    let quote = null;
    const flush = () => { if (started) words.push(word); [word, started] = ['', false]; };
    const end = () => { flush(); if (words.length) commands.push({ line: n + 1, words }); words = []; };
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (quote) {
        if (c === quote) quote = null;
        else if (quote === '"' && c === '\\') word += raw[++i] ?? '';
        else word += c;
      } else if (c === '"' || c === "'") [quote, started] = [c, true];
      else if (c === '#' && !started) break;
      else if (/\s/.test(c)) flush();
      else if (c === '$' && raw[i + 1] === '{') {
        const close = raw.indexOf('}', i);
        word += close < 0 ? raw.slice(i) : raw.slice(i, close + 1);
        [i, started] = [close < 0 ? raw.length : close, true];
      } else if (c === '$' && raw[i + 1] === '(') { end(); i++; }
      else if (';&|()`{}<>'.includes(c)) end();
      else [word, started] = [word + c, true];
    }
    end();
    heredoc = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(raw)?.[2] ?? null;
  });
  return commands;
};

function markdownReads(root, env, revision) {
  const entries = execFileSync('git', ['-C', root, 'ls-tree', '-r', '-z', revision], { env, encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\0').filter(Boolean).map(entry => {
      const [mode, , id] = entry.slice(0, entry.indexOf('\t')).split(' ');
      return { mode, id, file: entry.slice(entry.indexOf('\t') + 1) };
    });
  const documents = new Set(entries.filter(({ mode, file }) => mode === '100644' && isDocument(file)).map(({ file }) => file));
  const holds = new Set([...documents].flatMap(file => file.split('/').slice(0, -1).map((_, n, parts) => parts.slice(0, n + 1).join('/'))));
  const kind = file => /\.(?:[cm]?[jt]sx?|svelte)$/.test(file) ? 'js' : file.endsWith('.py') ? 'py'
    : /\.(?:sh|bash|ya?ml)$/.test(file) ? 'sh' : /(?:^|\/)[^./]+$/.test(file) ? 'script' : null;
  const code = entries.filter(({ mode, file }) => REGULAR.includes(mode) && kind(file)
    && !file.split('/').some(part => ['RAWS', '.local', 'node_modules'].includes(part)));
  const batch = spawnSync('git', ['-C', root, 'cat-file', '--batch'], { env, input: code.map(({ id }) => `${id}\n`).join(''), maxBuffer: 512 << 20 });
  if (batch.status !== 0) throw Error(`cannot read the tracked code of ${revision} for Markdown reads`);
  const texts = new Map();
  for (let at = 0, n = 0; n < code.length; n++) {
    const header = batch.stdout.indexOf(10, at);
    // a missing object (a pruned or partial clone) hides what the file reads: fail closed
    const size = header < 0 ? null : /^[0-9a-f]+ blob (\d+)$/.exec(batch.stdout.toString('latin1', at, header))?.[1];
    if (size == null) throw Error(`cannot read the tracked code of ${revision} for Markdown reads: ${code[n].file}`);
    texts.set(code[n].file, batch.stdout.toString('utf8', header + 1, header + 1 + Number(size)));
    at = header + Number(size) + 2;
  }
  const found = new Map();
  const normal = file => {
    const normalized = path.posix.normalize(file).replace(/\/+$/, '').replace(/^\.\//, '');
    return normalized === '.' ? '' : normalized;
  };
  // value: a path in which UNKNOWN stands for each part that cannot be told and HERE for the reader's own directory
  // guess: a read site, where a file name under an unknown directory reads every document of that name
  const locate = (reader, line, value, { directory = false, exact = false, guess = false } = {}) => {
    const note = document => found.set(`${reader}\0${line}\0${document}`, { reader, line, document });
    const here = path.posix.dirname(reader);
    const anchored = value.includes(HERE);
    let file = anchored ? here + value.slice(value.lastIndexOf(HERE) + 1) : value;
    const unrooted = /^\0+\//.test(file); // an unknown directory leads: the repository's root, or another
    if (unrooted) file = file.replace(/^\0+\/+/, '');
    const places = rest => [...new Set([normal(rest), ...(anchored || unrooted ? [] : [normal(path.posix.join(here, rest))])])];
    if (!file.includes(UNKNOWN)) {
      const hits = places(file).filter(place => documents.has(place) || directory && holds.has(place));
      hits.forEach(place => note(documents.has(place) ? place : `${place}/`));
      if (!hits.length && guess && unrooted && file.endsWith('.md')) [...documents].filter(doc => doc.endsWith(`/${normal(file)}`)).forEach(note);
      return;
    }
    const tail = file.slice(file.lastIndexOf(UNKNOWN) + 1);
    if (exact || /\.\w+$/.test(tail) && !tail.endsWith('.md')) return;
    const prefix = file.slice(0, file.indexOf(UNKNOWN));
    const parent = normal(prefix.endsWith('/') ? prefix : path.posix.dirname(prefix));
    if (!parent) return;
    const hits = places(parent).filter(place => holds.has(place));
    hits.forEach(place => note(`${place}/`));
    if (!hits.length && guess && unrooted) [...holds].filter(dir => dir.endsWith(`/${parent}`)).forEach(dir => note(`${dir}/`));
  };
  const scanJs = (reader, text) => {
    const tree = ts.createSourceFile(reader, text, ts.ScriptTarget.Latest, true);
    // each name's constants and parameter defaults (the path a function reads unless told otherwise), in source order;
    // a use takes the nearest one before it
    const consts = new Map();
    (function collect(node) {
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name) && node.initializer) {
        consts.set(node.name.text, [...(consts.get(node.name.text) ?? []), node]);
      }
      ts.forEachChild(node, collect);
    })(tree);
    const declared = use => {
      const all = consts.get(use.text) ?? [];
      return (all.filter(declaration => declaration.pos < use.pos).at(-1) ?? all[0])?.initializer;
    };
    const lineOf = node => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
    const nameOf = node => ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : '';
    const valueOf = (node, depth = 0) => {
      const next = child => valueOf(child, depth + 1);
      if (!node || depth > 12) return UNKNOWN;
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
          || ts.isSatisfiesExpression?.(node)) return next(node.expression);
      if (ts.isStringLiteralLike(node)) return node.text;
      if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => next(span.expression) + span.literal.text).join('');
      if (ts.isBinaryExpression(node)) {
        const operator = node.operatorToken.kind;
        if (operator === ts.SyntaxKind.PlusToken) return next(node.left) + next(node.right);
        if (operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken) {
          const left = next(node.left);
          return left === UNKNOWN ? next(node.right) : left;
        }
        return UNKNOWN;
      }
      if (ts.isConditionalExpression(node)) {
        const first = next(node.whenTrue);
        return first === UNKNOWN ? next(node.whenFalse) : first;
      }
      if (ts.isIdentifier(node)) {
        if (node.text === '__dirname') return HERE;
        if (node.text === '__filename') return `${HERE}/${path.posix.basename(reader)}`;
        const initializer = declared(node);
        return initializer ? next(initializer) : UNKNOWN;
      }
      const text = ts.isPropertyAccessExpression(node) ? node.getText(tree) : '';
      if (text === 'import.meta.dirname') return HERE;
      if (text === 'import.meta.url' || text === 'import.meta.filename') return `${HERE}/${path.posix.basename(reader)}`;
      if (ts.isPropertyAccessExpression(node) && ['pathname', 'href'].includes(node.name.text)) return next(node.expression);
      if (ts.isNewExpression(node) && nameOf(node.expression) === 'URL' && node.arguments?.length) {
        const [target, from] = node.arguments;
        return from ? `${next(from)}/../${next(target)}` : next(target);
      }
      if (!ts.isCallExpression(node)) return UNKNOWN;
      const name = nameOf(node.expression);
      const args = node.arguments.map(next);
      if (name === 'join' && args.length > 1 || name === 'resolve' && args.length) return args.join('/');
      if (['fileURLToPath', 'normalize', 'String'].includes(name) && args.length) return args[0];
      if (name === 'toString' && ts.isPropertyAccessExpression(node.expression)) return next(node.expression.expression);
      if (name === 'dirname' && args.length) return `${args[0]}/..`;
      if (name === 'cwd') return '.';
      return UNKNOWN;
    };
    const written = new Set();
    (function visit(node) {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const name = nameOf(node.expression);
        const args = node.arguments ?? [];
        const line = lineOf(node);
        if (JS_WRITE.test(name)) args.forEach(arg => written.add(ts.skipOuterExpressions(arg)));
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) locate(reader, line, `${HERE}/${valueOf(args[0]).split('?')[0]}`, { guess: true });
        else if (JS_READ.has(name) || name === 'file' && node.expression.getText(tree) === 'Bun.file') {
          locate(reader, line, valueOf(args[0]), { directory: JS_DIRECTORY.has(name), guess: true });
        } else if (name === 'join' && args.length > 1 || name === 'resolve' && args.length || ts.isNewExpression(node) && name === 'URL') {
          if (!written.has(node)) locate(reader, line, valueOf(node));
        } else if (!JS_TEXT.test(name) && !JS_WRITE.test(name)) {
          args.flatMap(arg => ts.isArrayLiteralExpression(arg) ? [...arg.elements] : [arg]).filter(arg => ts.isStringLiteralLike(arg))
            .forEach(arg => locate(reader, lineOf(arg), arg.text, { exact: true }));
        }
      }
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
          && ts.isStringLiteralLike(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith('.')) {
        locate(reader, lineOf(node), `${HERE}/${node.moduleSpecifier.text.split('?')[0]}`, { exact: true });
      }
      ts.forEachChild(node, visit);
    })(tree);
  };
  const scanPython = (reader, text) => {
    const lines = pythonLines(text);
    const definitions = new Map();
    lines.forEach(({ blank }, n) => {
      const name = /^\s*([A-Za-z_]\w*)\s*(?::[^=]*)?=(?!=)/.exec(blank)?.[1];
      if (name) definitions.set(name, [...(definitions.get(name) ?? []), n]);
    });
    // a line's paths: each string, and each run of strings joined by the / operator or by join() (an unknown directory
    // before it when something else leads)
    const paths = ({ blank, strings }) => {
      const runs = [];
      const run = (at, text, lead) => {
        const before = (blank.slice(0, at).match(/""/g) ?? []).length;
        const count = (text.match(/""/g) ?? []).length;
        if (count) runs.push(`${lead ? `${UNKNOWN}/` : ''}${strings.slice(before, before + count).join('/')}`);
      };
      for (const match of blank.matchAll(/(\/\s*)?""(?:\s*\/\s*"")*/g)) if (match[1] || match[0].length > 2) run(match.index, match[0], match[1]);
      for (const match of blank.matchAll(/\bjoin\s*\(([^()]*)\)/g)) run(match.index, match[0], /^\s*[^"\s]/.test(match[1]));
      return [...strings, ...runs];
    };
    lines.forEach((line, n) => {
      const reading = PY_READ.test(line.blank);
      if (!reading && (PY_WRITE.test(line.blank) || !/\/\s*""|\bPath\s*\(|\bos\.path\.join\s*\(/.test(line.blank))) return;
      // a read follows the names it uses to their assignments, two steps deep
      const sources = [line];
      for (let depth = 0, from = [n], seen = new Set([n]); reading && depth < 2; depth++) {
        from = from.flatMap(at => (lines[at].blank.match(/\b[A-Za-z_]\w*\b/g) ?? []).flatMap(name => definitions.get(name) ?? []))
          .filter(at => !seen.has(at) && seen.add(at));
        sources.push(...from.map(at => lines[at]));
      }
      const directory = PY_DIRECTORY.test(line.blank);
      sources.flatMap(paths).forEach(value => locate(reader, n + 1, value, { directory, guess: reading }));
    });
  };
  const scanShell = (reader, text) => {
    for (const { line, words } of shellCommands(text)) {
      let k = 0;
      while (k < words.length && (/^[A-Za-z_]\w*=/.test(words[k]) || SH_PREFIX.has(words[k]))) k++;
      if (k >= words.length || SH_TEXT.has(words[k])) continue;
      for (const word of words.slice(k).map(word => word.slice(word.lastIndexOf('=') + 1))) {
        const variable = /^\$\{?([A-Za-z_]\w*)\}?\/(.*)$/.exec(word);
        if (variable && !SH_ROOT.test(variable[1])) {
          if (variable[2].endsWith('.md')) locate(reader, line, `${UNKNOWN}/${dollars(variable[2])}`, { guess: true });
        } else if (/[/.]/.test(variable ? variable[2] : word)) locate(reader, line, dollars(variable ? variable[2] : word), { directory: true, guess: true });
      }
    }
  };
  for (const { file } of code) {
    let text = texts.get(file);
    let language = kind(file);
    if (language === 'script') {
      const shebang = /^#!.*\b(python3?|bash|sh|zsh|node|bun)\b/.exec(text)?.[1];
      language = !shebang ? null : shebang.startsWith('python') ? 'py' : ['node', 'bun'].includes(shebang) ? 'js' : 'sh';
      if (language === 'js') text = text.replace(/^#!.*/, '');
    }
    // a component's scripts, its markup blanked line for line
    if (file.endsWith('.svelte')) text = text.replace(/(<script[^>]*>[\s\S]*?<\/script>)|[^\n]+/g, (all, script) => script ? all.replace(/^<script[^>]*>|<\/script>$/g, '') : '');
    if (language === 'js') scanJs(file, text);
    else if (language === 'py') scanPython(file, text);
    else if (language === 'sh') scanShell(file, text);
  }
  return { documents: [...documents].sort(), reads: [...found.values()].sort((a, b) => a.reader.localeCompare(b.reader) || a.line - b.line) };
}
const CONFIG_FILE = /(?:^|\/)(?:(?:vitest|vite|jest|playwright)\.(?:config|workspace|setup)[^/]*|bunfig\.toml)$/;
const TEST_SCRIPT = /^(?:pre|post)?test(?::|$)/;
// Runner configuration keys that name files run in the test process or around it (Vitest, Jest, Playwright).
const SETUP_KEYS = new Set(['setupFiles', 'setupFilesAfterEnv', 'globalSetup', 'globalTeardown']);
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
  // an ambient declaration (declare const expect: any) names nothing the module defines, so it does not bind
  return symbol?.declarations?.find(declaration => declaration.getSourceFile() === tree && !(declaration.flags & ts.NodeFlags.Ambient));
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
// Literal module specifiers a file imports, re-exports, requires or loads (type-only ones too, unless `types` is
// false); a nonliteral one refuses, or is skipped when `strict` is false (the module under test, which may load what it
// likes).
const importsOf = (tree, file, strict = true, types = true) => {
  const imports = tree.referencedFiles.map(ref => './' + ref.fileName);
  const nonliteral = () => {
    if (strict) throw Error(`nonliteral protected import: ${file}`);
  };
  (function visit(node) {
    const erased = !types && ((ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) || (ts.isExportDeclaration(node) && node.isTypeOnly)
      || (ts.isImportEqualsDeclaration(node) && node.isTypeOnly));
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && !erased) imports.push(node.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && !erased) {
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
// The script of a JS/TS module or of a Svelte component's <script> blocks, read by the Svelte parser; undefined for other
// files. A component that does not parse fails closed.
const scriptOf = (file, text) => {
  if (/\.(?:[cm]?[jt]sx?)$/.test(file)) return text;
  if (!file.endsWith('.svelte')) return undefined;
  try {
    const { module, instance } = parse(text, { modern: true, filename: file });
    return [module, instance].filter(Boolean).map(script => text.slice(script.content.start, script.content.end)).join('\n');
  } catch (error) {
    throw Error(`cannot parse Svelte component ${file}: ${String(error.message).split('\n')[0]}`);
  }
};
// What a module runs when it is used: its script, or for a Svelte component the compiled output, which also holds the
// markup's expressions and event handlers. Undefined for other files.
const runnableOf = (file, text) => {
  const script = scriptOf(file, text);
  if (script === undefined || !file.endsWith('.svelte')) return script;
  try {
    return compile(text, { generate: 'client', filename: file }).js.code;
  } catch (error) {
    throw Error(`cannot compile Svelte component ${file}: ${String(error.message).split('\n')[0]}`);
  }
};
// The global object, under any of its names, and what a module may hold of it. Beyond the global object three more
// names are capabilities a changed module can use to rewrite what the runner and its matchers do: Symbol (Symbol.for
// reaches the matcher registry), the builtins every matcher calls (Object, Array, Reflect, ...) and code generation.
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window', 'self', 'frames', 'top', 'parent']);
const frameworkName = name => FRAMEWORK_GLOBALS.has(name) || /jest|vitest|chai/i.test(name);
// The standard builtins (and the few host classes) the matchers and the runner call: rewritten once, rewritten for all.
const BUILTINS = new Set(['Object', 'Function', 'Array', 'Number', 'Boolean', 'String', 'Symbol', 'BigInt', 'Date', 'Promise',
  'RegExp', 'Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'Map',
  'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array',
  'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'Atomics', 'JSON', 'Math', 'Reflect', 'Proxy', 'Intl', 'Iterator', 'Buffer', 'URL',
  'URLSearchParams', 'TextEncoder', 'TextDecoder']);
const CONVERTERS = new Set(['String', 'Number', 'Boolean', 'BigInt']);
const MUTATORS = new Set(['Object.defineProperty', 'Object.defineProperties', 'Object.assign', 'Object.setPrototypeOf',
  'Reflect.set', 'Reflect.defineProperty', 'Reflect.setPrototypeOf', 'Reflect.deleteProperty']);
const kindOf = name => (GLOBAL_OBJECTS.has(name) ? 'global' : name === 'Symbol' ? 'symbol' : BUILTINS.has(name) ? 'builtin' : undefined);
// Writes the guard leaves to the reviewer: they cannot change what a matcher or the runner does.
const PROCESS_STATE = /^process\.(?:env|exitCode)(?:\.|$)/;
const wrapper = node => ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
  || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node) || ts.isAwaitExpression(node);
const unwrap = node => {
  while (node && wrapper(node)) node = node.expression;
  return node;
};
// the outermost wrapper (parentheses, a cast, an await) around an expression
const up = node => {
  while (node.parent && wrapper(node.parent) && node.parent.expression === node) node = node.parent;
  return node;
};
const literal = expression => (expression && ts.isStringLiteralLike(expression) ? expression.text : undefined);
// A pure key whose value cannot be established (a cycle or an unavailable export) is different from a runtime key.
const UNRESOLVED_KEY = Symbol('unresolved fixed key');
const MAX_KEY_CHOICES = 256; // exceeding this refuses; it never makes a fixed key look runtime
const keyChoices = value => value instanceof Set ? value : [value];
const joinKeys = (left, right) => {
  if (left === undefined || right === undefined) return undefined;
  if (left === UNRESOLVED_KEY || right === UNRESOLVED_KEY) return UNRESOLVED_KEY;
  if (typeof left === 'string' && typeof right === 'string') return left + right;
  const joined = new Set();
  for (const a of keyChoices(left)) for (const b of keyChoices(right)) {
    joined.add(a + b);
    if (joined.size > MAX_KEY_CHOICES) return UNRESOLVED_KEY;
  }
  return joined.size === 1 ? [...joined][0] : joined;
};
// The name a key spells before the module runs. A declaration and export visited set bounds cycles, without an
// arbitrary limit on literal trees or const chains. Undefined means the key depends on a runtime value.
const keyName = (tree, checker, key, declaredKey, seen = new Set()) => {
  key = unwrap(key);
  if (!key) return undefined;
  if (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) return key.text;
  if (key.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (key.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (key.kind === ts.SyntaxKind.NullKeyword) return 'null';
  if (ts.isBigIntLiteral(key)) return key.text.replace(/n$/, '');
  if (ts.isTemplateExpression(key)) {
    let text = key.head.text;
    for (const span of key.templateSpans) {
      const part = keyName(tree, checker, span.expression, declaredKey, seen);
      text = joinKeys(joinKeys(text, part), span.literal.text);
      if (text === undefined || text === UNRESOLVED_KEY) return text;
    }
    return text;
  }
  if (ts.isBinaryExpression(key) && key.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = keyName(tree, checker, key.left, declaredKey, seen);
    const right = keyName(tree, checker, key.right, declaredKey, seen);
    return joinKeys(left, right);
  }
  if (ts.isBinaryExpression(key)) {
    if (key.operatorToken.kind === ts.SyntaxKind.CommaToken) return keyName(tree, checker, key.right, declaredKey, seen);
    const left = keyName(tree, checker, key.left, declaredKey, seen);
    const right = keyName(tree, checker, key.right, declaredKey, seen);
    return left === undefined || right === undefined ? undefined : UNRESOLVED_KEY;
  }
  if (ts.isConditionalExpression(key)) {
    if (key.condition.kind === ts.SyntaxKind.TrueKeyword) return keyName(tree, checker, key.whenTrue, declaredKey, seen);
    if (key.condition.kind === ts.SyntaxKind.FalseKeyword) return keyName(tree, checker, key.whenFalse, declaredKey, seen);
    const yes = keyName(tree, checker, key.whenTrue, declaredKey, seen);
    const no = keyName(tree, checker, key.whenFalse, declaredKey, seen);
    if (yes === undefined || no === undefined) return undefined;
    if (yes === UNRESOLVED_KEY || no === UNRESOLVED_KEY) return UNRESOLVED_KEY;
    const options = new Set([...keyChoices(yes), ...keyChoices(no)]);
    return options.size > MAX_KEY_CHOICES ? UNRESOLVED_KEY : options.size === 1 ? [...options][0] : options;
  }
  if (ts.isArrayLiteralExpression(key)) {
    const parts = key.elements.map(element => ts.isSpreadElement(element) ? undefined : keyName(tree, checker, element, declaredKey, seen));
    return parts.includes(undefined) ? undefined : UNRESOLVED_KEY; // array coercion is fixed, but not a string literal tree
  }
  if (ts.isPropertyAccessExpression(key) || ts.isElementAccessExpression(key)) {
    const members = [];
    let root = key;
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
      const member = ts.isPropertyAccessExpression(root) ? root.name.text : finishKey(keyName(tree, checker, root.argumentExpression, declaredKey, seen));
      if (member === undefined || member === UNRESOLVED_KEY) return member;
      members.unshift(member);
      root = unwrap(root.expression);
    }
    if (ts.isIdentifier(root)) {
      const declaration = declarationOf(checker, tree, root);
      const alias = declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && declaration.parent.flags & ts.NodeFlags.Const
        && ts.isIdentifier(unwrap(declaration.initializer));
      if (declaration && (importedFrom(declaration) !== undefined || alias)) {
        if (seen.has(declaration)) return UNRESOLVED_KEY;
        seen.add(declaration);
        try { return declaredKey(declaration, seen, members); } finally { seen.delete(declaration); }
      }
    }
    if (ts.isObjectLiteralExpression(root) || ts.isArrayLiteralExpression(root)) return UNRESOLVED_KEY;
    return undefined;
  }
  if (ts.isPrefixUnaryExpression(key) || ts.isVoidExpression(key) || ts.isTypeOfExpression(key)) {
    const operand = key.operand ?? key.expression;
    return keyName(tree, checker, operand, declaredKey, seen) === undefined ? undefined : UNRESOLVED_KEY;
  }
  if (ts.isIdentifier(key)) {
    const declaration = declarationOf(checker, tree, key);
    if (!declaration) return undefined;
    if (seen.has(declaration)) return UNRESOLVED_KEY;
    seen.add(declaration);
    try { return declaredKey(declaration, seen); } finally { seen.delete(declaration); }
  }
  if (ts.isCallExpression(key) && key.expression.getText(tree).replace(/\s/g, '') === 'Symbol.for') return literal(key.arguments[0]);
  return undefined;
};
// The keys by which a value of any origin reaches a shared constructor or prototype (x.constructor, x.__proto__,
// x.__lookupGetter__). rootOf, destructured() and the pattern sweep in reachesFramework all decide it here.
const isSpecialKey = key => typeof key === 'string' && /^(?:constructor|__\w+__)$/.test(key);
const finishKey = key => key instanceof Set ? [...key].some(isSpecialKey) ? UNRESOLVED_KEY : undefined : key;
const isExported = node => Boolean(node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
const loadBuiltin = createRequire(import.meta.url);
// whether a builtin module has an export (one the guard's runtime does not know is assumed to)
const builtinHas = (specifier, name) => {
  try {
    return name in loadBuiltin(specifier);
  } catch {
    return true;
  }
};
// What a root is as a capability a module may use only in place (see held() below): the global object, Symbol, a
// standard builtin, a builtin module object, or a constructor or prototype, as [kind, name]. A member of one (Object.keys,
// fs.readFile, fs.promises) is a plain value, though a write through it is still a write to a builtin.
const capabilityOf = root => {
  if (!root?.global && !root?.path) return undefined;
  if (root.global) return ['global', 'the global object'];
  if (root.path === 'Symbol') return ['symbol', 'Symbol'];
  return root.module || BUILTINS.has(root.path) || /(?:^|\.)(?:prototype|constructor|__proto__)$|\(\)$/.test(root.path) ? ['builtin', root.path] : undefined;
};
// What a module's values are rooted at, read once per module text and shared by the modules that import it. rootOf(node)
// is the shared runtime object an expression's value is, or is read from:
//  - { global: true }: the global object, under any of its names;
//  - { path }: an unbound global (Object, console, ...), a Node or Bun builtin module (with `module` for the module object
//    rather than one of its members), a constructor or prototype (getPrototypeOf, constructor, __proto__, the super of a
//    class that extends one), or a member of any of these;
//  - { namespace }: a local module's namespace object, whose members are that module's exports;
//  - undefined: anything else, the module's own objects included.
// It follows a value through const, let and var initialisers, destructuring, await, conditional, logical, comma and
// assignment expressions, a literal require or import(), and an import binding into the module that exports it (export
// const, export { x as y }, export default, a re-export, export *), across modules. `exporter(file, specifier)` gives
// the tracked module a specifier binds to at HEAD as { file, text }; a package is not followed. rootOf does not follow
// a value into a function's parameter, out of its return value, or through an object or array literal or a class field:
// held() refuses moving a capability there, and a plain member moved there is left to the reviewer.
const analyses = new WeakMap();
const analysisOf = (file, text, exporter) => {
  if (!analyses.has(exporter)) analyses.set(exporter, new Map());
  const cache = analyses.get(exporter);
  if (cache.has(`${file}\0${text}`)) return cache.get(`${file}\0${text}`);
  const { tree, checker } = bind(file, text);
  const self = { tree, checker };
  cache.set(`${file}\0${text}`, self);
  const keyValue = (key, seen = new Set()) => keyName(tree, checker, key, keyOfDeclaration, seen);
  const fixedKey = (key, seen = new Set()) => finishKey(keyValue(key, seen));
  const fromKey = (specifier, name, seen) => {
    if (!specifier || isBuiltin(specifier)) return UNRESOLVED_KEY;
    const target = exporter(file, specifier);
    return target ? analysisOf(target.file, target.text, exporter).exportKey(name, seen) : UNRESOLVED_KEY;
  };
  const keyOfDeclaration = (declaration, seen, members = []) => {
    const source = importedFrom(declaration);
    if (source !== undefined) {
      if (ts.isNamespaceImport(declaration)) return members.length ? fromKey(source, members.join('.'), seen) : undefined;
      const name = ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : 'default';
      return fromKey(source, [name, ...members].join('.'), seen);
    }
    if (members.length) {
      const target = ts.isVariableDeclaration(declaration) && declaration.initializer && declaration.parent.flags & ts.NodeFlags.Const
        && ts.isIdentifier(unwrap(declaration.initializer)) ? declarationOf(checker, tree, unwrap(declaration.initializer)) : undefined;
      if (!target) return undefined; // a local object's members can change at runtime
      if (seen.has(target)) return UNRESOLVED_KEY;
      seen.add(target);
      try { return keyOfDeclaration(target, seen, members); } finally { seen.delete(target); }
    }
    return ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) && declaration.initializer
      && declaration.parent.flags & ts.NodeFlags.Const ? keyValue(declaration.initializer, seen) : undefined;
  };
  const exportKey = (name, seen = new Set()) => {
    const mark = `key\0${file}\0${name}`;
    if (seen.has(mark)) return UNRESOLVED_KEY;
    seen.add(mark);
    try {
      const [first, ...members] = name.split('.');
      const suffix = members.length ? `.${members.join('.')}` : '';
      const stars = [];
      for (const statement of tree.statements) {
        if (ts.isVariableStatement(statement) && isExported(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === first) return keyOfDeclaration(declaration, seen, members);
          }
        }
        if (ts.isExportAssignment(statement) && first === 'default') return members.length ? UNRESOLVED_KEY : keyValue(statement.expression, seen);
        if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
        if (!statement.exportClause) { stars.push(literal(statement.moduleSpecifier)); continue; }
        if (ts.isNamespaceExport(statement.exportClause)) {
          if (statement.exportClause.name.text === first) return members.length
            ? fromKey(literal(statement.moduleSpecifier), members.join('.'), seen) : undefined;
          continue;
        }
        const element = statement.exportClause.elements.find(part => !part.isTypeOnly && part.name.text === first);
        if (!element) continue;
        if (statement.moduleSpecifier) return fromKey(literal(statement.moduleSpecifier), (element.propertyName ?? element.name).text + suffix, seen);
        const declaration = checker.getExportSpecifierLocalTargetSymbol(element)?.declarations
          ?.find(part => part.getSourceFile() === tree && !(part.flags & ts.NodeFlags.Ambient));
        return declaration ? keyOfDeclaration(declaration, seen, members) : UNRESOLVED_KEY;
      }
      for (const specifier of name === 'default' ? [] : stars) {
        const result = fromKey(specifier, name, seen);
        if (result !== UNRESOLVED_KEY) return result;
      }
      return UNRESOLVED_KEY;
    } finally { seen.delete(mark); }
  };
  const member = (root, key, seen) => {
    if (root.global) {
      if (key === undefined) return { path: 'a computed member of the global object' };
      return GLOBAL_OBJECTS.has(key) ? root : key in globalThis ? { path: key } : undefined;
    }
    if (root.namespace) return key === undefined ? undefined : root.namespace.exportRoot(key, seen);
    return { path: `${root.path}.${key ?? '[computed]'}` };
  };
  // what the module a specifier names exports under `name` ('*' for its namespace or module object); node:process is
  // left to the reviewer
  const from = (specifier, name, seen) => {
    if (isBuiltin(specifier)) {
      if (/^(?:node:)?process$/.test(specifier)) return undefined;
      return name === '*' || name === 'default' ? { path: specifier, module: true } : { path: `${specifier}.${name}` };
    }
    const target = specifier && exporter(file, specifier);
    if (!target) return undefined;
    const other = analysisOf(target.file, target.text, exporter);
    return name === '*' ? { namespace: other } : other.exportRoot(name, seen);
  };
  const declared = (declaration, seen) => {
    if (seen.has(declaration)) return undefined;
    seen.add(declaration);
    try {
      const source = importedFrom(declaration);
      if (source !== undefined) {
        return from(source, ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text
          : ts.isImportClause(declaration) ? 'default' : '*', seen);
      }
      if (ts.isVariableDeclaration(declaration)) return ts.isIdentifier(declaration.name) && declaration.initializer ? rootOf(declaration.initializer, seen) : undefined;
      return ts.isBindingElement(declaration) ? destructured(declaration, seen) : undefined;
    } finally {
      seen.delete(declaration);
    }
  };
  // a destructured binding: the initializer's root, then the key of each pattern it sits in (a rest holds the same members)
  const destructured = (element, seen) => {
    const keys = [];
    let node = element;
    for (; ts.isBindingElement(node); node = node.parent.parent) {
      if (node.dotDotDotToken) continue;
      const name = node.propertyName ?? node.name;
      keys.unshift(ts.isArrayBindingPattern(node.parent) ? String(node.parent.elements.indexOf(node))
        : ts.isComputedPropertyName(name) ? fixedKey(name.expression) : name.text);
    }
    // a parameter, catch or for-of binding has no initialiser; any value still has the constructor rootOf(x.constructor) reads
    let root = ts.isVariableDeclaration(node) && node.initializer ? rootOf(node.initializer, seen) : undefined;
    for (const key of keys) root = root ? member(root, key === UNRESOLVED_KEY ? undefined : key, seen) : isSpecialKey(key) ? { path: key } : undefined;
    return root;
  };
  // super: the class a class extends, in a static member, or its prototype, in an instance member
  const superOf = (node, seen) => {
    let scope = node.parent;
    while (scope && !(ts.isFunctionLike(scope) && !ts.isArrowFunction(scope)) && !ts.isPropertyDeclaration(scope)
      && !ts.isClassStaticBlockDeclaration(scope)) scope = scope.parent;
    const owner = scope?.parent;
    const heritage = owner && ts.isClassLike(owner)
      ? owner.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression : undefined;
    const base = heritage && rootOf(heritage, seen);
    if (!base) return undefined;
    const isStatic = ts.isClassStaticBlockDeclaration(scope) || scope.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword);
    return isStatic ? base : member(base, 'prototype', seen);
  };
  const rootOf = (node, seen = new Set()) => {
    node = unwrap(node);
    if (!node) return undefined;
    if (ts.isConditionalExpression(node)) return rootOf(node.whenTrue, seen) ?? rootOf(node.whenFalse, seen);
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (operator === ts.SyntaxKind.CommaToken || operator === ts.SyntaxKind.EqualsToken) return rootOf(node.right, seen);
      return [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(operator)
        ? rootOf(node.left, seen) ?? rootOf(node.right, seen) : undefined;
    }
    if (ts.isIdentifier(node)) {
      const declaration = declarationOf(checker, tree, node);
      if (!declaration) return GLOBAL_OBJECTS.has(node.text) ? { global: true } : node.text in globalThis ? { path: node.text } : undefined;
      return declared(declaration, seen);
    }
    if (node.kind === ts.SyntaxKind.SuperKeyword) return superOf(node, seen);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const named = ts.isPropertyAccessExpression(node) ? node.name.text : fixedKey(node.argumentExpression);
      const key = named === UNRESOLVED_KEY ? undefined : named;
      const inner = rootOf(node.expression, seen);
      if (inner) return member(inner, key, seen);
      return isSpecialKey(key) ? { path: key } : undefined;
    }
    if (ts.isCallExpression(node)) {
      const specifier = node.arguments.length === 1 ? literal(node.arguments[0]) : undefined;
      if (specifier !== undefined && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(tree) === 'require')) {
        return from(specifier, '*', seen);
      }
      const callee = rootOf(node.expression, seen);
      return callee?.path && /(?:^|\.)getPrototypeOf$/.test(callee.path) ? { path: `${callee.path}()` } : undefined;
    }
    return undefined;
  };
  // the binding a declaration name (an identifier or a destructuring pattern) gives `name`
  const named = (binding, name) => {
    if (ts.isIdentifier(binding)) return binding.text === name ? binding.parent : undefined;
    for (const element of binding.elements) {
      if (ts.isOmittedExpression(element)) continue;
      const found = ts.isIdentifier(element.name) ? (element.name.text === name ? element : undefined) : named(element.name, name);
      if (found) return found;
    }
    return undefined;
  };
  // an export specifier's value: the local binding it names, or the export it re-exports
  const exportedBy = (element, seen = new Set()) => {
    const specifier = literal(element.parent.parent.moduleSpecifier);
    if (element.parent.parent.moduleSpecifier) return from(specifier, (element.propertyName ?? element.name).text, seen);
    const declaration = checker.getExportSpecifierLocalTargetSymbol(element)?.declarations
      ?.find(found => found.getSourceFile() === tree && !(found.flags & ts.NodeFlags.Ambient));
    return declaration ? declared(declaration, seen) : undefined;
  };
  // the root of what this module exports under `name`
  const exportRoot = (name, seen = new Set()) => {
    const mark = `${file}\0${name}`;
    if (seen.has(mark)) return undefined;
    seen.add(mark);
    try {
      const stars = [];
      for (const statement of tree.statements) {
        if (ts.isVariableStatement(statement) && isExported(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            const binding = named(declaration.name, name);
            if (binding) return declared(binding, seen);
          }
        }
        if (ts.isImportEqualsDeclaration(statement) && isExported(statement) && statement.name.text === name) return declared(statement, seen);
        if (ts.isExportAssignment(statement) && name === 'default') return rootOf(statement.expression, seen);
        if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
        const clause = statement.exportClause;
        if (!clause) stars.push(literal(statement.moduleSpecifier));
        else if (ts.isNamespaceExport(clause)) {
          if (clause.name.text === name) return from(literal(statement.moduleSpecifier), '*', seen);
        } else {
          const element = clause.elements.find(found => !found.isTypeOnly && found.name.text === name);
          if (element) return exportedBy(element, seen);
        }
      }
      // export * passes on every name but default; a builtin module passes on only the names it has
      for (const specifier of name === 'default' ? [] : stars) {
        if (isBuiltin(specifier) && !builtinHas(specifier, name)) continue;
        const root = from(specifier, name, seen);
        if (root) return root;
      }
      return undefined;
    } finally {
      seen.delete(mark);
    }
  };
  const bindingNames = binding => ts.isIdentifier(binding) ? [binding.text]
    : binding.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
  const capabilityExport = (seen = new Set(), includeDefault = false) => {
    if (seen.has(file)) return undefined;
    seen.add(file);
    try {
      for (const statement of tree.statements) {
        const names = ts.isVariableStatement(statement) && isExported(statement)
          ? statement.declarationList.declarations.flatMap(declaration => bindingNames(declaration.name))
          : isExported(statement) && statement.name ? [statement.name.text]
            : ts.isExportAssignment(statement) ? ['default']
              : ts.isExportDeclaration(statement) && statement.exportClause
                ? ts.isNamespaceExport(statement.exportClause) ? [statement.exportClause.name.text]
                  : statement.exportClause.elements.filter(element => !element.isTypeOnly).map(element => element.name.text) : [];
        for (const name of names) {
          if (name === 'default' && !includeDefault) continue; // export * does not forward default
          const root = exportRoot(name);
          const found = capabilityOf(root) ?? root?.namespace?.capabilityExport(seen, true);
          if (found) return found;
        }
        if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && !statement.exportClause) {
          const target = from(literal(statement.moduleSpecifier), '*', new Set());
          const found = target?.namespace?.capabilityExport(seen);
          if (found) return found;
        }
      }
      return undefined;
    } finally {
      seen.delete(file);
    }
  };
  Object.assign(self, { rootOf, exportedBy, exportRoot, capabilityExport, from, exportKey, fixedKey });
  return self;
};
// How a module reaches the test framework or rewrites what the named tests rely on, if it does: a framework import,
// require or load (or a framework package passed to any call, such as a require made by createRequire), an unbound
// expect, vi, vitest, jest or chai, import.meta.vitest; and, by an allowlist rather than by the shapes known to
// misbehave, what it may do with a capability, wherever its value comes from (rootOf above: a name, an alias, a
// destructuring, an import from another module, super, constructor, __proto__, getPrototypeOf):
//  - the global object (globalThis, window, ...) may appear only as the object of a property read with a literal,
//    non-framework name, or in a const initialiser (each use of the const is then checked the same way);
//  - Symbol.for only as a direct call with a literal, non-framework name;
//  - a builtin (Object, Array, Reflect, ...), a builtin module object (fs, path, ...), a constructor or a prototype only
//    called, constructed, extended, compared, read by name, or (a converter such as String or Number) passed to a call;
//  - none of them exported, under any name, or moved anywhere else (an argument, a return value, a property, an
//    element, a let, an assignment);
//  - no assignment, update, delete, defineProperty-style call or for-in/of target rooted at an unbound global, its
//    prototype, a builtin module, or a prototype reached by getPrototypeOf, constructor, __proto__ or super.
// `exporter` lets rootOf follow an import into the module that exports it; without one, imports are not followed.
const noExporter = () => undefined;
const reachesFramework = (file, text, exporter = noExporter) => {
  const { tree, checker, rootOf, exportedBy, from, fixedKey } = analysisOf(file, text, exporter);
  const unbound = id => !declarationOf(checker, tree, id);
  const propertyKey = name => (ts.isComputedPropertyName(name) ? fixedKey(name.expression) : name.text);
  // whether an object literal is a destructuring target: the left of =, a for-in/of head, or inside another such pattern
  const assignmentTarget = node => {
    const top = up(node);
    const parent = top.parent;
    if (ts.isBinaryExpression(parent)) return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === top;
    if (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) return parent.initializer === top;
    if (ts.isPropertyAssignment(parent)) return parent.initializer === top && assignmentTarget(parent.parent);
    if (ts.isArrayLiteralExpression(parent)) return assignmentTarget(parent);
    return (ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)) && assignmentTarget(parent.parent);
  };
  // A special key in any object pattern, a binding or an assignment target, whatever its source (a variable, a parameter,
  // a catch binding, a for-of head, a default): the value it reads is a shared constructor or prototype.
  const patternKey = node => {
    const names = ts.isObjectBindingPattern(node) ? node.elements.filter(element => !element.dotDotDotToken).map(element => element.propertyName ?? element.name)
      : ts.isObjectLiteralExpression(node) && assignmentTarget(node)
        ? node.properties.filter(property => ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)).map(property => property.name) : [];
    return names.map(propertyKey).find(key => key === UNRESOLVED_KEY || isSpecialKey(key));
  };
  // types have no runtime effect, but the expression a class extends does run
  const inType = node => Boolean(ts.findAncestor(node, ancestor => ts.isTypeNode(ancestor)
    && !(ts.isExpressionWithTypeArguments(ancestor) && ts.isHeritageClause(ancestor.parent) && ancestor.parent.token === ts.SyntaxKind.ExtendsKeyword
      && ts.isClassLike(ancestor.parent.parent))));
  // Why `node`, an expression that evaluates to a capability of `kind` (named `name`), is held beyond a plain use;
  // undefined when this use is allowed.
  const held = (node, kind, name) => {
    const top = up(node);
    const parent = top.parent;
    const operator = ts.isBinaryExpression(parent) ? parent.operatorToken.kind : undefined;
    if (ts.isTypeOfExpression(parent) || (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken)
        || ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isConditionalExpression(parent)) && (parent.expression ?? parent.condition) === top)
        || operator === ts.SyntaxKind.AmpersandAmpersandToken && parent.left === top || [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(operator)
        || ([ts.SyntaxKind.InKeyword, ts.SyntaxKind.InstanceOfKeyword].includes(operator) && parent.right === top)) return undefined;
    // a write replaces the member on its object (x.constructor = v): mutation() judges it by that object
    if ((operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment && parent.left === top) || ts.isDeleteExpression(parent)) return undefined;
    const reachedBy = (access, key) => {
      if (BANNED_PROPERTY.test(key) && kind !== 'builtin') return `${name}.${key}`;
      if (kind === 'global') {
        if (frameworkName(key)) return `the global ${key}`;
        return kindOf(key) ? held(access, kindOf(key), key) : undefined;
      }
      if (kind === 'symbol') {
        if (key !== 'for') return undefined;
        const outer = up(access);
        return ts.isCallExpression(outer.parent) && outer.parent.expression === outer && outer.parent.arguments.length === 1
          && literal(outer.parent.arguments[0]) !== undefined && !frameworkName(literal(outer.parent.arguments[0])) ? undefined
          : 'Symbol.for other than a direct call with a literal name';
      }
      return BANNED_PROPERTY.test(key) ? held(access, 'builtin', `${name}.${key}`) : undefined;
    };
    if (ts.isPropertyAccessExpression(parent) && parent.expression === top) return reachedBy(parent, parent.name.text);
    if (ts.isElementAccessExpression(parent) && parent.expression === top) {
      const named = fixedKey(parent.argumentExpression);
      const key = named === UNRESOLVED_KEY ? undefined : named;
      return key === undefined ? `a computed member of ${kind === 'global' ? 'the global object' : name}` : reachedBy(parent, key);
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === top) {
      if (ts.isIdentifier(parent.name)) {
        if (!(parent.parent.flags & ts.NodeFlags.Const)) return `${name} held in a variable that is not const`;
        // each use of the const is a value rooted at the same capability, checked where it appears
        return isExported(parent.parent.parent) ? `${name} exported` : undefined;
      }
      if (ts.isObjectBindingPattern(parent.name)) {
        for (const element of parent.name.elements) {
          if (element.dotDotDotToken) return `the rest of ${name}`;
          const key = element.propertyName ?? element.name;
          const named = ts.isComputedPropertyName(key) ? fixedKey(key.expression) : key.text;
          if (named === undefined || named === UNRESOLVED_KEY) return `a computed member of ${name}`;
          const reason = reachedBy(element, named);
          if (reason) return reason;
        }
        return undefined;
      }
    }
    if (kind !== 'global') {
      if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === top) return undefined;
      if (ts.isTaggedTemplateExpression(parent) && parent.tag === top) return undefined;
      if (ts.isExpressionWithTypeArguments(parent) && ts.isHeritageClause(parent.parent) && parent.parent.token === ts.SyntaxKind.ExtendsKeyword) return undefined;
      if (kind === 'builtin' && CONVERTERS.has(name) && (ts.isCallExpression(parent) || ts.isNewExpression(parent))) return undefined;
    }
    return kind === 'global' ? 'the global object held other than as a literal property read'
      : kind === 'symbol' ? 'Symbol held other than called or read by name' : `${name} held or passed as a value`;
  };
  // the places an assignment, update, delete or loop writes: the targets inside a destructuring pattern included
  const written = node => {
    node = unwrap(node);
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.flatMap(property => ts.isPropertyAssignment(property) ? written(property.initializer)
        : ts.isShorthandPropertyAssignment(property) ? [property.name] : ts.isSpreadAssignment(property) ? written(property.expression) : []);
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(element => (ts.isSpreadElement(element) ? written(element.expression) : written(element)));
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return written(node.left);
    return [node];
  };
  // a name declared in an enclosing scope; in a CommonJS file the binder also files `module.exports = x` and `exports.x = y`
  // under `module` and `exports`, as expando declarations of an expression, which declare nothing
  const expando = declaration => ts.isBinaryExpression(declaration) || ts.isPropertyAccessExpression(declaration)
    || ts.isElementAccessExpression(declaration) || ts.isIdentifier(declaration) || ts.isSourceFile(declaration);
  const localBinding = id => Boolean(ts.findAncestor(id, scope => scope.locals?.get(id.text)?.declarations?.some(declaration => !expando(declaration))));
  const commonJsName = node => (ts.isIdentifier(node) && (node.text === 'module' || node.text === 'exports') && isReference(node) && !inType(node)
    && !localBinding(node) ? `references the unbound CommonJS ${node.text}` : undefined);
  const commonJsExport = target => {
    target = unwrap(target);
    if (ts.isIdentifier(target)) return target.text === 'exports' && !localBinding(target);
    if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return false;
    const object = unwrap(target.expression);
    if (ts.isIdentifier(object) && object.text === 'module' && !localBinding(object)) {
      const key = ts.isPropertyAccessExpression(target) ? target.name.text : fixedKey(target.argumentExpression);
      return key === 'exports';
    }
    return commonJsExport(object);
  };
  const mutation = node => {
    const targets = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? written(node.left)
      : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) ? written(node.operand)
        : ts.isDeleteExpression(node) ? written(node.expression)
          : (ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer) ? written(node.initializer) : [];
    for (const target of targets.map(unwrap)) {
      if (commonJsExport(target)) return 'assigns a CommonJS export';
      if (ts.isIdentifier(target) && !unbound(target)) continue; // rebinding a local variable changes nothing shared
      // writing a member changes the object it is read from (super.x = v sets x on this); writing a global name changes
      // that name
      const member = ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target);
      if (member && unwrap(target.expression).kind === ts.SyntaxKind.SuperKeyword) continue;
      const inner = member ? rootOf(target.expression) : undefined;
      const root = member && !inner?.global ? inner : rootOf(target);
      if (root?.path && !PROCESS_STATE.test(rootOf(target)?.path ?? root.path)) return `writes to ${root.path}`;
    }
    if (ts.isCallExpression(node)) {
      const callee = rootOf(node.expression);
      const name = callee?.path?.replace(/\.(?:call|apply|bind)$/, '');
      if (name && MUTATORS.has(name) && node.arguments.some(argument => rootOf(argument)?.path)) return `${name} on a builtin`;
      if (/\.__define[GS]etter__$/.test(callee?.path ?? '')) return `${callee.path} on a builtin`;
    }
    return undefined;
  };
  // A capability is checked where its value first appears: a name or an alias, an import, a member that is one of
  // something that is not (x.constructor, a namespace's export), a call (getPrototypeOf, require, import()) or super.
  // A member of a capability is checked by held() from the capability itself.
  const appears = node => {
    if (inType(node)) return undefined;
    const access = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
    if (!(ts.isIdentifier(node) ? isReference(node) : access || ts.isCallExpression(node) || node.kind === ts.SyntaxKind.SuperKeyword)) return undefined;
    const found = capabilityOf(rootOf(node));
    if (!found || (access && capabilityOf(rootOf(node.expression)))) return undefined;
    return held(node, found[0], ts.isIdentifier(node) && unbound(node) ? node.text : found[1]);
  };
  // An export is a move like any other: a capability exported under any name, or re-exported, refuses.
  const exports = node => {
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && !node.exportClause) {
      const found = from(literal(node.moduleSpecifier), '*', new Set())?.namespace?.capabilityExport();
      return found && `${found[1]} exported by *`;
    }
    if (ts.isExportSpecifier(node) && !node.isTypeOnly && !node.parent.parent.isTypeOnly) {
      const found = capabilityOf(exportedBy(node));
      return found && `${found[1]} exported as ${node.name.text}`;
    }
    if (ts.isNamespaceExport(node)) {
      const root = from(literal(node.parent.moduleSpecifier), '*', new Set());
      const found = capabilityOf(root) ?? root?.namespace?.capabilityExport(new Set(), true);
      return found && `${found[1]} exported as ${node.name.text}`;
    }
    if (ts.isImportEqualsDeclaration(node) && !ts.isExternalModuleReference(node.moduleReference)) {
      return `an import alias of ${node.moduleReference.getText(tree)}, which the guard does not follow`;
    }
    if (ts.isImportEqualsDeclaration(node) && isExported(node)) {
      const found = capabilityOf(rootOf(node.name));
      return found && `${found[1]} exported as ${node.name.text}`;
    }
    return undefined;
  };
  let reach;
  (function visit(node) {
    if (reach) return;
    const call = ts.isCallExpression(node) ? node.expression.getText(tree).replace(/\s/g, '') : undefined;
    const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? literal(node.moduleSpecifier)
      : ts.isImportEqualsDeclaration(node) ? literal(node.moduleReference.expression)
        : call === 'import' || call === 'require' ? literal(node.arguments[0]) : undefined;
    if (specifier !== undefined && FRAMEWORK.test(specifier)) reach = `loads ${specifier}`;
    else if ((ts.isCallExpression(node) || ts.isNewExpression(node))
        && (node.arguments ?? []).some(argument => FRAMEWORK.test(literal(argument) ?? ''))) reach = `names ${literal(node.arguments.find(argument => FRAMEWORK.test(literal(argument) ?? '')))} to ${node.expression.getText(tree)}`;
    else if (ts.isMetaProperty(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === 'vitest') reach = 'import.meta.vitest';
    else {
      const key = patternKey(node);
      reach = key ? key === UNRESOLVED_KEY ? 'cannot resolve a fixed computed pattern key' : `destructures ${key}`
        : ts.isElementAccessExpression(node) && fixedKey(node.argumentExpression) === UNRESOLVED_KEY
          ? 'cannot resolve a fixed computed element key' : appears(node) ?? exports(node) ?? commonJsName(node);
    }
    if (!reach && ts.isIdentifier(node) && REACH.has(node.text) && isReference(node)) {
      const declaration = declarationOf(checker, tree, node);
      if (!declaration || (importedFrom(declaration) !== undefined && FRAMEWORK.test(importedFrom(declaration)))) reach = `uses ${node.text}`;
    }
    reach ||= mutation(node);
    ts.forEachChild(node, visit);
  })(tree);
  return reach;
};
// What a module does while it is imported, if anything: a top-level statement other than a declaration, or a call,
// construction, tagged template, JSX element, await, assignment, update, delete, decorator or class static block
// outside a function body. Function bodies, constructors and instance fields run later; a property read is not counted.
const importTimeEffect = (file, text) => {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const at = node => `${ts.SyntaxKind[node.kind]} at ${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`;
  const assigns = node => ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
    && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  const updates = node => (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
    && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator);
  const isStatic = node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword);
  const effect = node => {
    if (ts.isTypeNode(node)) return undefined;
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node) || ts.isAwaitExpression(node)
        || ts.isYieldExpression(node) || ts.isDeleteExpression(node) || ts.isDecorator(node) || ts.isClassStaticBlockDeclaration(node)
        || ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node) || assigns(node) || updates(node)) return at(node);
    // decorators and a computed name are evaluated where the function or field is defined; the body or initializer
    // runs later
    if (ts.isFunctionLike(node) || (ts.isPropertyDeclaration(node) && !isStatic(node))) {
      const decorator = [node, ...(node.parameters ?? [])].flatMap(part => part.modifiers ?? []).find(ts.isDecorator);
      if (decorator) return at(decorator);
      return node.name && ts.isComputedPropertyName(node.name) ? effect(node.name) : undefined;
    }
    return ts.forEachChild(node, effect);
  };
  for (const statement of tree.statements) {
    if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) continue;
    if (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) continue; // a directive
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)
        || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEmptyStatement(statement)) continue;
    if (!(ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)
        || ts.isVariableStatement(statement) || ts.isExportAssignment(statement))) return `top-level ${at(statement)}`;
    const found = effect(statement);
    if (found) return found;
  }
  return undefined;
};
const isBuiltin = specifier => /^(?:node|bun):/.test(specifier) || builtinModules.includes(specifier);

function main() {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const command = separator < 0 ? [] : args.splice(separator).slice(1);
  const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
  const root = realpathSync(options['--root']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  env.LC_ALL = 'C';
  const git = (...words) => execFileSync('git', ['-C', root, ...words], { env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  // --read-documents REV judges nothing: it prints READ_DOCUMENTS, REV's documents and the Markdown reads its tracked
  // code makes, for the control that keeps the list whole (ReadDocuments in tests/agent-tools/test_docs_only.py).
  if (options['--read-documents'] !== undefined) {
    const revision = git('rev-parse', '--verify', `${options['--read-documents']}^{commit}`).trim();
    console.log(JSON.stringify({ list: READ_DOCUMENTS, ...markdownReads(root, env, revision) }));
    return 0;
  }
  const base = git('rev-parse', '--verify', `${options['--fix-base']}^{commit}`).trim();
  const head = git('rev-parse', 'HEAD').trim();
  if (realpathSync(git('rev-parse', '--show-toplevel').trim()) !== root
      || root !== options['--expected-root'] || head !== options['--expected-head']
      || base !== options['--expected-base']) throw Error('guard repository identity differs from receipt collector');
  if (git('merge-base', base, head).trim() !== base) throw Error('fix base must be an ancestor of HEAD');
  if (git('status', '--porcelain=v1', '--untracked-files=all').trim()) throw Error('fix diff needs a clean tree');
  // At a wave head, fix-round-guard bounds a no-test declaration at the tip of the fix round's own line (--fix-head).
  const tip = options['--fix-head'] === undefined ? head : git('rev-parse', '--verify', `${options['--fix-head']}^{commit}`).trim();
  if (tip !== head && (git('merge-base', tip, head).trim() !== tip || git('merge-base', base, tip).trim() !== base)) {
    throw Error('fix head must lie between the fix base and HEAD');
  }
  const namedTestReference = options['--named-test-reference'] === undefined ? undefined
    : git('rev-parse', '--verify', `${options['--named-test-reference']}^{commit}`).trim();
  if (namedTestReference && git('merge-base', namedTestReference, head).trim() !== namedTestReference) {
    throw Error('named-test reference must be an ancestor of HEAD');
  }
  // A manifest's range spans every later merge from the base it targets. --trusted-base is that base's commit, which
  // fix-round-guard passes only for an explicit --base and no --ledger (CI: the pull request's base branch). A path that
  // changed between the fix base and HEAD is the base's change, and not this branch's, when the base is merged into HEAD,
  // the fix base held the copy of every commit it shares with the base (merge-base --all) and HEAD holds the base's
  // copy, mode and blob alike. Without a trusted base, or with one HEAD has not merged, every change is the branch's.
  const trusted = options['--trusted-base'] === undefined ? undefined
    : git('rev-parse', '--verify', `${options['--trusted-base']}^{commit}`).trim();
  const common = trusted && spawnSync('git', ['-C', root, 'merge-base', '--all', base, trusted], { env, encoding: 'utf8' });
  const forks = common?.status === 0 ? common.stdout.split('\n').filter(Boolean) : [];
  const merged = forks.length > 0 && spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', trusted, tip], { env }).status === 0;
  // The base commits HEAD holds: the trusted base once merged, else the newest base state HEAD merged before it moved on.
  const held = forks.length > 0 && spawnSync('git', ['-C', root, 'merge-base', '--all', trusted, tip], { env, encoding: 'utf8' });
  const received = held?.status === 0 ? held.stdout.split('\n').filter(Boolean) : [];
  // a revision's tracked files: path -> { mode, id }, parsed once for the base-change test and the closures alike
  const parseTree = output => new Map(output.split('\0').filter(Boolean).map(entry => {
    const [mode, , id] = entry.slice(0, entry.indexOf('\t')).split(' ');
    return [entry.slice(entry.indexOf('\t') + 1), { mode, id }];
  }));
  const trees = new Map();
  const tracked = revision => {
    if (!trees.has(revision)) {
      trees.set(revision, parseTree(git('ls-tree', '-r', '-z', revision)));
    }
    return trees.get(revision);
  };
  // Arrival history needs individual paths, not a full retained repository tree per candidate commit.
  // Reuse an existing inventory; otherwise cache just the exact requested entry, including absence.
  const entries = new Map();
  const trackedEntry = (revision, file) => {
    if (trees.has(revision)) return trees.get(revision).get(file);
    if (!entries.has(revision)) entries.set(revision, new Map());
    const files = entries.get(revision);
    if (!files.has(file)) {
      files.set(file, parseTree(git('--literal-pathspecs', 'ls-tree', '-r', '-z', revision, '--', file)).get(file));
    }
    return files.get(file);
  };
  const treeEntry = (revision, file) => {
    const entry = trackedEntry(revision, file);
    return entry && `${entry.mode} ${entry.id}`;
  };
  // A key neither HEAD nor the fix base tracks (a derived entry whose origin was not mapped, a typo) is nobody's change:
  // undefined === undefined must not read as "the base's copy".
  const fromBase = file => merged && (treeEntry(tip, file) !== undefined || treeEntry(base, file) !== undefined)
    && treeEntry(tip, file) === treeEntry(trusted, file)
    && forks.every(fork => treeEntry(fork, file) === treeEntry(base, file));
  // Equality alone cannot establish arrival: candidate-only commits can hide on any merged side ancestry. Inspect
  // every candidate-only commit reachable from HEAD, including commits before a later deletion or restoration. Compare
  // each commit with its first parent: retaining that parent's copy at a merge is no edit, even if another parent has
  // older or absent bytes. A protected path may change only in a two-parent merge whose second parent is trusted
  // history and whose result preserves that parent's exact mode/blob. This keeps genuine arrivals and trusted updates while refusing edits
  // anywhere in merged candidate history.
  let arrivalHistory;
  const trustedAncestors = new Map();
  const fromTrusted = revision => {
    if (!trustedAncestors.has(revision)) {
      trustedAncestors.set(revision,
        spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', revision, trusted], { env }).status === 0);
    }
    return trustedAncestors.get(revision);
  };
  const arrivals = new Map();
  const trustedArrival = file => {
    if (arrivals.has(file)) return arrivals.get(file);
    const prove = () => {
      if (treeEntry(base, file) !== undefined || !fromBase(file)) return false;
      arrivalHistory ??= git('rev-list', '--topo-order', '--parents', tip, `^${trusted}`).trim().split('\n')
        .filter(Boolean).map(row => row.split(' '));
      let introduced = false;
      for (const [revision, ...parents] of arrivalHistory) {
        const after = treeEntry(revision, file);
        const [first, second, ...rest] = parents;
        if (after === (first ? treeEntry(first, file) : undefined)) continue;
        if (!first || !second || rest.length || !REGULAR.includes(trackedEntry(revision, file)?.mode)
            || after !== treeEntry(second, file) || !fromTrusted(second)) return false;
        if (treeEntry(first, file) === undefined) introduced = true;
      }
      return introduced;
    };
    const proven = prove();
    arrivals.set(file, proven);
    return proven;
  };
  // A path the base added, changed or deleted after the review is one whose copy at a base commit HEAD holds differs from
  // the copy at every merge base of that commit with the fix base, and from the fix base's. The fix base's copy is no
  // reference for it (an addition's absence least of all, a rename's new path included): the base's copy HEAD received
  // is, at each base commit HEAD holds. A received copy equal to the fix base's is nothing to protect, and so is a received
  // commit's copy of a path the base had not yet changed when that commit and the fix base parted. None without a trusted
  // base.
  const parted = new Map();
  const forksOf = revision => {
    if (!parted.has(revision)) parted.set(revision, git('merge-base', '--all', base, revision).split('\n').filter(Boolean));
    return parted.get(revision);
  };
  const baseCopies = file => received.filter(revision => [...forksOf(revision), base].every(other => treeEntry(other, file) !== treeEntry(revision, file)));
  // the base's changes that HEAD received and then undid: the tip holds the fix base's copy (an absent path included), so it
  // shows no difference from the fix base, but it is not the base's copy. The branch reverted, deleted or masked them.
  const reverted = [...new Set([base, ...received].flatMap(revision => [...tracked(revision).keys()]))]
    .filter(file => treeEntry(tip, file) === treeEntry(base, file) && baseCopies(file).length);
  // A path's references: the fix base's copy and each base copy above. Every site that judges HEAD against a reviewed copy
  // (the named tests, the protected test files, the rest of the closure, the fixtures, the docs-only paths, the assertion
  // counts and the modules a changed module loads) takes them all, so no site can judge a path the base changed after the
  // review against the fix base alone.
  const references = file => [base, ...baseCopies(file)];
  // the base commits HEAD received that changed some path after the review, each a reference for the paths it changed
  const changers = received.filter(revision => git('diff', '--no-renames', '--name-only', '-z', base, revision).split('\0')
    .filter(Boolean).some(file => baseCopies(file).includes(revision)));
  // the suffix of a refusal that judged HEAD against the base's copy
  const against = reference => (reference === base ? '' : ` (against the base's copy at ${reference.slice(0, 12)}, which the base changed after the review)`);
  // The paths HEAD holds otherwise than a reference: the fix diff less the base's changes HEAD holds as the base does,
  // and the base's changes HEAD received and undid. Renames are off, so a renamed file is deleted at its old path and
  // added at its new one, and the old path keeps its assertion count.
  const diff = git('diff', '--no-renames', '--name-only', '-z', base, tip).split('\0').filter(Boolean);
  const changed = diff.filter(file => !fromBase(file));
  const touched = [...changed, ...reverted];
  const inherited = [];
  const proceed = () => {
    if (!command.length) return 0;
    const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit', cwd: root, env });
    if (result.error) throw result.error;
    return result.status ?? 1;
  };
  const findings = JSON.parse(readFileSync(options['--findings'], 'utf8'));
  const protectedFiles = new Set();
  if (Object.hasOwn(findings, 'protection')) {
    const protection = findings.protection;
    const refuse = why => { throw Error(`file protection ${why}`); };
    const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).sort().join() === keys;
    const full = value => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
    const repoPath = value => typeof value === 'string' && value.length && !/[\\\\\x00-\x1f\x7f]/.test(value)
      && !path.isAbsolute(value) && value.split('/').every(part => part && !['.', '..', '.git', '.local', 'RAWS'].includes(part));
    if (!shape(protection, 'files,kind,review') || protection.kind !== 'files'
        || !Array.isArray(protection.files) || !protection.files.length) refuse('requires explicit kind files and a nonempty files list');
    if (!Array.isArray(findings.tests) || findings.tests.length || Object.hasOwn(findings, 'noTests')) {
      refuse('is exclusive with named tests and noTests; tests must be []');
    }
    if (!shape(protection.review, 'file,sha256') || !repoPath(protection.review.file)
        || typeof protection.review.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(protection.review.sha256)) {
      refuse('requires a committed review file and SHA256');
    }
    if (findings.fixBase !== base || !/^[0-9a-f]{64}$/.test(findings.reviewFindingsSha256 ?? '')
        || typeof findings.unit !== 'string' || !/^[A-Z][A-Z0-9]*-[1-9][0-9]*\/[a-z][a-z0-9-]*$/.test(findings.unit)) {
      refuse('requires the original unit and review findings hash');
    }
    const ancestor = (older, newer) => spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', older, newer], { env }).status === 0;
    const commit = revision => {
      if (!full(revision)) return false;
      const result = spawnSync('git', ['-C', root, 'rev-parse', '--verify', `${revision}^{commit}`], { env, encoding: 'utf8' });
      return result.status === 0 && result.stdout.trim() === revision;
    };
    const regular = (revision, file) => REGULAR.includes(tracked(revision).get(file)?.mode);
    if (!regular(head, protection.review.file)) refuse('review must be a committed regular file');
    const bytes = execFileSync('git', ['-C', root, 'show', `${head}:${protection.review.file}`], { env, maxBuffer: 32 * 1024 * 1024 });
    if (createHash('sha256').update(bytes).digest('hex') !== protection.review.sha256) refuse('review hash differs from committed bytes');
    const review = JSON.parse(bytes.toString('utf8'));
    if (!shape(review, 'files,fixBase,fresh,implementer,reviewFindingsSha256,reviewedHead,reviewer,schema,unit,verdict')
        || review.schema !== 'clearcase-file-protection-review/1' || review.unit !== findings.unit
        || review.fixBase !== base || review.reviewFindingsSha256 !== findings.reviewFindingsSha256
        || review.verdict !== 'PASS' || review.fresh !== true
        || typeof review.reviewer !== 'string' || !review.reviewer.trim()
        || typeof review.implementer !== 'string' || !review.implementer.trim() || review.reviewer === review.implementer
        || !commit(review.reviewedHead) || !ancestor(base, review.reviewedHead) || !ancestor(review.reviewedHead, head)
        || !Array.isArray(review.files) || review.files.length !== protection.files.length) refuse('review provenance or original range binding is invalid');
    for (const [index, entry] of protection.files.entries()) {
      const approved = review.files[index];
      if (!shape(entry, 'file,revision') || !repoPath(entry.file) || !commit(entry.revision) || protectedFiles.has(entry.file)
          || !shape(approved, 'file,revision') || approved.file !== entry.file || approved.revision !== entry.revision
          || entry.file === protection.review.file || !ancestor(base, entry.revision) || !ancestor(entry.revision, review.reviewedHead)) {
        refuse('files must be unique repository paths and full ancestor revisions identical to the separate review');
      }
      if (!regular(entry.revision, entry.file) || !regular(head, entry.file)
          || treeEntry(entry.revision, entry.file) !== treeEntry(head, entry.file)) {
        refuse(`committed regular-file bytes or mode changed/deleted: ${entry.file}`);
      }
      protectedFiles.add(entry.file);
    }
  }
  // A no-test declaration (docs/agent-tooling.md, Docs-only fix rounds): the review named no test, so the manifest names
  // none, binds the declaration to the reviewed commit and the review's findings hash, and gives a reason. Its range may
  // change only Markdown documentation outside code and test directories, and the manifest itself. Nothing else runs.
  if (findings.noTests !== undefined) {
    const declared = findings.noTests;
    const refuse = why => { throw Error(`no-test declaration ${why}`); };
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)
        || Object.keys(declared).sort().join() !== 'reason,reviewFindingsSha256,reviewSha') {
      refuse('must be an object holding exactly reviewSha, reviewFindingsSha256 and reason');
    }
    if (!Array.isArray(findings.tests) || findings.tests.length) refuse('stands for an empty tests list: a manifest names tests or declares none, never both');
    if (findings.assertionCountReasons !== undefined) refuse('excuses no test change, so assertionCountReasons has no place beside it');
    if (declared.reviewSha !== base) refuse(`names ${String(declared.reviewSha).slice(0, 12)}, not the reviewed fix base ${base.slice(0, 12)} in full`);
    if (!/^[0-9a-f]{64}$/.test(String(declared.reviewFindingsSha256)) || declared.reviewFindingsSha256 !== findings.reviewFindingsSha256) {
      refuse('must name the review findings hash the manifest names in reviewFindingsSha256');
    }
    if (typeof declared.reason !== 'string' || !declared.reason.trim()) refuse('needs a reason');
    const own = path.relative(root, realpathSync(options['--findings'])).split(path.sep).join('/');
    const offending = [];
    const documents = [];
    inherited.push(...diff.filter(fromBase));
    // a base change the round undid leaves no difference from the fix base, but it is this round's change; a document is a
    // regular file, or absent, at the tip and at each of its references
    for (const file of touched) {
      if (file === own) documents.push(file);
      else if (isDocument(file) && [tip, ...references(file)].every(revision => [undefined, '100644'].includes(tracked(revision).get(file)?.mode))) documents.push(file);
      else offending.push(file);
    }
    if (offending.length) {
      refuse(`covers a docs-only range, but ${base.slice(0, 12)}..${tip.slice(0, 12)} changes ${offending.join(', ')}; only `
        + 'regular Markdown files outside source, script and test directories, and the manifest itself, may change');
    }
    // A document that code or a test reads is that check's input, not documentation: one READ_DOCUMENTS lists, or one
    // code reads at the fix base, a received base reference or the tip (which catches a reader this branch adds). A
    // removed or renamed document may not exist at the tip for markdownReads() to associate with its reader. Scan each
    // distinct snapshot once; naming a file is not reading it.
    const reads = [...new Set([base, ...received, tip])].flatMap(revision => markdownReads(root, env, revision).reads);
    const inputs = documents.filter(file => file !== own).flatMap(file => {
      const read = reads.find(({ document }) => file === document || document.endsWith('/') && file.startsWith(document));
      const why = [listed(file) && 'READ_DOCUMENTS lists it', read && `${read.reader}:${read.line} reads it, or names it in a path it builds`];
      return why.some(Boolean) ? [`${file} (${why.filter(Boolean).join('; ')})`] : [];
    });
    if (inputs.length) {
      refuse(`covers a docs-only range, but ${inputs.join(', ')} changed beside it: a check reads it as an input, and a `
        + 'docs-only round cannot vouch for that check');
    }
    if (inherited.length) {
      console.log(`test-guard: ${inherited.length} changed file(s) are the base's, not this fix round's: the base ${trusted} `
        + `is merged into ${tip} and it holds each as the base does`);
    }
    console.log(`test-guard: PASS (docs-only, no tests named: ${documents.length} changed file(s); ${base}..${tip}`
      + `${tip === head ? '' : `, the fix round's line in ${head}`}${trusted ? `; trusted base ${trusted}` : ''})`);
    return proceed();
  }
  if (tip !== head) throw Error('a fix head bounds a no-test declaration only');
  if (!Array.isArray(findings.tests) || (!findings.tests.length && !protectedFiles.size)) {
    throw Error('findings.tests must be a nonempty list of {file, name}; a fix round that protects no test declares it in noTests');
  }
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
  const parsed = new Map();
  const load = (revision, file) => {
    if (!supported(file)) throw Error(`unsupported protected test syntax: ${file}; JS/TS required`);
    if (!parsed.has(`${revision}:${file}`)) parsed.set(`${revision}:${file}`, parse(file, source(revision, file)));
    return parsed.get(`${revision}:${file}`);
  };
  // A closure entry is a tracked file's text, or what of a package.json steers the run: its test scripts, and the fields
  // through which it steers resolution (a dependency or version edit does not).
  const derive = {
    '': text => text,
    '#scripts': text => {
      const scripts = JSON.parse(text).scripts ?? {};
      return JSON.stringify(Object.keys(scripts).filter(name => TEST_SCRIPT.test(name)).sort().map(name => [name, scripts[name]]));
    },
    '#resolution': text => {
      const manifest = JSON.parse(text);
      return JSON.stringify(['name', 'type', 'main', 'module', 'browser', 'imports', 'exports'].map(key => manifest[key] ?? null));
    },
  };
  // a closure entry's value at a revision, read from its origin's copy there (undefined where the revision lacks it)
  const entryAt = (revision, key, origin) => (treeEntry(revision, origin) === undefined ? undefined
    : derive[key.slice(origin.length)](source(revision, origin)));
  // Resolve imports against Git snapshots, never the worker's filesystem or module loader. Only test code is followed.
  const closure = (revision, starts) => {
    const modes = new Map([...tracked(revision)].map(([file, entry]) => [file, entry.mode]));
    const ids = new Map([...tracked(revision)].map(([file, entry]) => [file, entry.id]));
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
      // Kit 3 generates the same file under node_modules/$app/ (tsconfig.json extends "$app/tsconfig"); also ignored by Git.
      const errors = parsed.errors.filter(error => error.code !== 18003
        && !(error.code === 5083 && /[/\\]\.svelte-kit[/\\]tsconfig\.json/.test(ts.flattenDiagnosticMessageText(error.messageText, ' ')))
        && !(error.code === 6053 && ts.flattenDiagnosticMessageText(error.messageText, ' ') === "File '$app/tsconfig' not found."));
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
    // Files reached from named tests or setup entries are protected test code, even when a runner configuration also
    // imports them. Each role traverses its own graph: `found` holds text, not visitation state. This keeps runner
    // visitation from suppressing protected descendants and the inherited-runner exception from covering them.
    const protectedDeps = new Set();
    // The modules the named tests load (the test files, the support code they import, the setup files), as opposed to
    // the runner configuration and resolver inputs, which run in the runner or not at all. A test file loads what it
    // imports, through support code, and every setup file; it does not load what another named file imports.
    const edges = new Map();
    const shared = new Set();
    // The paths a path expression in a file names: a literal, relative to the repository (the runner's directory) and to
    // the file; the __dirname, import.meta.dirname and new URL(..., import.meta.url) forms, relative to the file, and
    // process.cwd(), the repository. A join, a resolve or a template literal may start from any of those three.
    const where = (tree, file, node) => {
      const folder = path.posix.dirname(file);
      const text = node => node && ts.isStringLiteralLike(node) ? node.text : undefined;
      const directory = node => (['__dirname', 'import.meta.dirname'].includes(node?.getText(tree)) ? folder
        : node?.getText(tree).replace(/\s/g, '') === 'process.cwd()' ? '.' : undefined);
      if (!node) return [];
      const literal = text(node);
      if (literal !== undefined) return [path.posix.normalize(literal), path.posix.normalize(path.posix.join(folder, literal))];
      if (ts.isNewExpression(node) && node.expression.getText(tree) === 'URL' && node.arguments?.length === 2
          && text(node.arguments[0]) !== undefined) return [path.posix.normalize(path.posix.join(folder, text(node.arguments[0])))];
      if (ts.isTemplateExpression(node) && !node.head.text && node.templateSpans.length === 1 && directory(node.templateSpans[0].expression)) {
        return [path.posix.normalize(path.posix.join(directory(node.templateSpans[0].expression), node.templateSpans[0].literal.text))];
      }
      if (ts.isCallExpression(node) && /(?:^|\.)(?:join|resolve)$/.test(node.expression.getText(tree))) {
        const [first, ...rest] = node.arguments;
        const parts = rest.map(text);
        if (!parts.length || parts.some(part => part === undefined)) return [];
        if (directory(first)) return [path.posix.normalize(path.posix.join(directory(first), ...parts))];
        if (text(first) !== undefined) return [path.posix.normalize(path.posix.join(text(first), ...parts))];
      }
      return [];
    };
    // The tracked files a setup entry names: a path expression above, a path without its extension, a
    // fileURLToPath(...) or require.resolve(...) of one. A package the root package.json declares binds to nothing;
    // any other entry, an ignored or missing file included, fails closed.
    const manifest = files.has('package.json') ? JSON.parse(source(revision, 'package.json')) : {};
    const declared = new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
      .flatMap(key => Object.keys(manifest[key] ?? {})));
    const bindPath = (file, literal) => {
      const bound = [path.posix.normalize(literal), path.posix.normalize(path.posix.join(path.posix.dirname(file), literal))].filter(candidate => files.has(candidate));
      const target = resolve(file, /^\.{0,2}\//.test(literal) ? literal : `./${literal}`);
      if (target) bound.push(target);
      const name = literal.split('/').slice(0, literal.startsWith('@') ? 2 : 1).join('/');
      if (bound.length || (!isLocal(literal) && declared.has(name))) return bound;
      throw Error(`cannot bind setup file entry '${literal}' in ${file} to a tracked file; the guard fails closed`);
    };
    const bindEntry = (tree, file, node) => {
      let entry = node;
      while (ts.isParenthesizedExpression(entry) || ts.isAsExpression(entry) || ts.isSatisfiesExpression(entry)) entry = entry.expression;
      const callee = ts.isCallExpression(entry) && entry.arguments.length === 1 ? entry.expression.getText(tree) : undefined;
      if (callee && /(?:^|\.)fileURLToPath$/.test(callee)) return bindEntry(tree, file, entry.arguments[0]);
      if (ts.isStringLiteralLike(entry) || (callee === 'require.resolve' && ts.isStringLiteralLike(entry.arguments[0]))) {
        return bindPath(file, ts.isStringLiteralLike(entry) ? entry.text : entry.arguments[0].text);
      }
      const bound = where(tree, file, entry).filter(candidate => files.has(candidate));
      if (!bound.length) throw Error(`cannot bind setup file entry ${entry.getText(tree)} in ${file} to a tracked file; the guard fails closed`);
      return bound;
    };
    // bun's preload: a string or a list of strings; any other mention of preload fails closed
    const preloads = (file, text) => {
      const code = text.replace(/#[^\n"']*$/gm, '');
      const values = [...code.matchAll(/^[ \t]*(?:test\.)?["']?preload["']?[ \t]*=[ \t]*(\[[^\]]*\]|"[^"]*"|'[^']*')/gm)].map(match => match[1]);
      const unbound = () => Error(`cannot bind a preload entry in ${file} to a tracked file; the guard fails closed`);
      if (values.length !== (code.match(/\bpreload["']?[ \t]*=/g) ?? []).length) throw unbound();
      return values.flatMap(value => {
        const strings = /^["']/.test(value) ? [value] : value.slice(1, -1).match(/"[^"]*"|'[^']*'/g) ?? [];
        if (/^\[/.test(value) && value.slice(1, -1).replace(/"[^"]*"|'[^']*'/g, '').replace(/[\s,]/g, '')) throw unbound();
        return strings.flatMap(string => bindPath(file, string.slice(1, -1)));
      });
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
      if (protectedDeps.has(file)) return;
      protectedDeps.add(file);
      if (!REGULAR.includes(modes.get(file))) throw Error(`symlink/submodule protected dependency refuses: ${file}`);
      if (file.split('/').some(part => part === 'RAWS' || part === '.local')) throw Error('private dependency cannot be inspected');
      const text = source(revision, file);
      found.set(file, text);
      edges.set(file, new Set());
      if (!supported(file)) return;
      const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      if (tree.parseDiagnostics.length) throw Error(`cannot parse protected dependency ${file}`);
      literalReads(tree, file);
      for (const specifier of importsOf(tree, file)) {
        const target = resolve(file, specifier);
        if (target) {
          if (isSupport(target)) { // the module under test is not followed
            edges.get(file).add(target);
            follow(target);
          }
        } else if (isLocal(specifier)) {
          throw Error(`unresolved local protected import ${specifier} in ${file}`);
        }
      }
    }
    starts.forEach(follow);
    const setup = file => {
      shared.add(file);
      follow(file);
    };
    // The runner configuration, every local module it imports (extensionless, .ts, .js or .mjs, through the resolver)
    // and the setup files it names decide whether and how the named tests run. All of it is compared as text.
    const runner = new Set();
    const configure = file => {
      if (runner.has(file)) return;
      runner.add(file);
      if (!REGULAR.includes(modes.get(file))) throw Error(`symlink/submodule protected configuration refuses: ${file}`);
      found.set(file, source(revision, file));
      if (path.posix.basename(file) === 'bunfig.toml') preloads(file, found.get(file)).forEach(setup);
      if (!supported(file)) return;
      const tree = ts.createSourceFile(file, found.get(file), ts.ScriptTarget.Latest, true);
      if (tree.parseDiagnostics.length) throw Error(`cannot parse protected configuration ${file}`);
      for (const specifier of importsOf(tree, file)) {
        const target = resolve(file, specifier);
        if (target) configure(target);
        else if (isLocal(specifier)) throw Error(`unresolved local runner configuration import ${specifier} in ${file}`);
      }
      // setup files: every setupFiles/globalSetup entry binds to a file or fails closed; beyond them, any path
      // expression, and a literal path without its extension, that lands on a module
      (function visit(node) {
        const key = (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
          && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) ? node.name.text : undefined;
        if (SETUP_KEYS.has(key)) {
          if (ts.isShorthandPropertyAssignment(node)) throw Error(`cannot bind setup file entry ${key} in ${file} to a tracked file; the guard fails closed`);
          let value = node.initializer;
          while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) value = value.expression;
          for (const entry of ts.isArrayLiteralExpression(value) ? value.elements : [value]) {
            if (ts.isOmittedExpression(entry)) continue;
            if (ts.isSpreadElement(entry)) throw Error(`cannot bind setup file entry ${entry.getText(tree)} in ${file} to a tracked file; the guard fails closed`);
            bindEntry(tree, file, entry).forEach(setup);
          }
        }
        const parent = node.parent;
        const moduleSpecifier = ts.isStringLiteralLike(node) && (
          ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node)
          || (ts.isExternalModuleReference(parent) && ts.isImportEqualsDeclaration(parent.parent)
            && parent.expression === node)
          || (ts.isCallExpression(parent) && parent.arguments[0] === node
            && (parent.expression.kind === ts.SyntaxKind.ImportKeyword || parent.expression.getText(tree) === 'require'))
        );
        if (moduleSpecifier) return;
        const candidates = where(tree, file, node);
        if (ts.isStringLiteralLike(node) && !/[*?{}\s]/.test(node.text)) {
          const target = resolve(file, /^\.{0,2}\//.test(node.text) ? node.text : `./${node.text}`);
          if (target) candidates.push(target);
        }
        for (const candidate of candidates) if (files.has(candidate) && supported(candidate)) setup(candidate);
        ts.forEachChild(node, visit);
      })(tree);
    };
    [...files].filter(file => CONFIG_FILE.test(file)).forEach(configure);
    // the tracked file a derived entry (test scripts, resolution fields) is read from
    const origins = new Map();
    if (files.has('package.json')) {
      found.set('package.json#scripts', derive['#scripts'](source(revision, 'package.json')));
      origins.set('package.json#scripts', 'package.json');
    }
    for (const [file, text] of resolutionInputs) {
      if (path.posix.basename(file) === 'package.json') {
        found.set(`${file}#resolution`, derive['#resolution'](text));
        origins.set(`${file}#resolution`, file);
      } else if (!found.has(file)) found.set(file, text);
    }
    // Fixtures: files in a fixture directory under a protected test's top-level directory, and files read by literal path.
    const tops = new Set(starts.filter(file => file.includes('/')).map(file => file.split('/')[0]));
    const fixture = file => {
      const parts = file.split('/');
      return tops.has(parts[0]) && parts.slice(1, -1).some(part => FIXTURE_DIR.test(part));
    };
    const data = new Set(reads);
    for (const file of files) if (fixture(file)) data.add(file);
    const loadedBy = start => {
      const seen = new Set();
      const walk = file => {
        if (seen.has(file)) return;
        seen.add(file);
        edges.get(file)?.forEach(walk);
      };
      [start, ...shared].forEach(walk);
      return seen;
    };
    return { found, ids, modes, data, fixture, runner, protectedDeps, resolve, loadedBy, declared, origin: key => origins.get(key) ?? key };
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
    // a named test stays as each reference holds it, so a base change to it after the review refuses until a new review
    for (const reference of new Set([...references(entry.file), ...(namedTestReference ? [namedTestReference] : [])])) {
      const old = (reference === base || exists(reference, entry.file) ? load(reference, entry.file).tests.get(entry.name) : undefined) ?? [];
      const current = load(head, entry.file).tests.get(entry.name) ?? [];
      if (old.length !== 1 || old[0].inactive) throw Error(`baseline test absent, ambiguous or inactive: ${entry.file}: ${entry.name}${against(reference)}`);
      if (current.length !== 1) throw Error(`named test deleted, renamed or ambiguous: ${entry.file}: ${entry.name}`);
      if (current[0].inactive) throw Error(`named test skipped/todo/isolated: ${entry.file}: ${entry.name}`);
      if (old[0].body !== current[0].body) throw Error(`named test changed (assertions may be removed or loosened): ${entry.file}: ${entry.name}`
        + (reference === namedTestReference ? ' (against the manifest\'s original fixBase)' : against(reference)));
    }
  }
  const starts = [...new Set(findings.tests.map(entry => entry.file))];
  const oldClosure = closure(base, starts);
  const currentClosure = closure(head, starts);
  // the protected closure at each reference, from the named tests' files it holds
  const snapshots = new Map([[base, oldClosure]]);
  const snapshotAt = revision => {
    if (!snapshots.has(revision)) snapshots.set(revision, closure(revision, starts.filter(file => tracked(revision).has(file))));
    return snapshots.get(revision);
  };
  const reasonFor = file => typeof reasons[file] === 'string' && reasons[file].trim();
  // the tracked file a specifier names, including one with an extension the resolver does not know (a Svelte
  // component), relative, through $lib or from the repository root (a leading /), without a ?query or #fragment
  const unquery = specifier => {
    const cut = specifier.search(/[?#]/);
    return cut > 0 ? specifier.slice(0, cut) : specifier;
  };
  const link = (snapshot, file, raw) => {
    const specifier = unquery(raw);
    const rooted = specifier.startsWith('/');
    const resolved = snapshot.resolve(file, rooted ? path.join(root, specifier) : specifier);
    if (resolved || !/\.\w+$/.test(specifier)) return resolved;
    const candidate = rooted ? path.posix.normalize(specifier.slice(1)) : specifier.startsWith('$lib/') ? path.posix.join('src/lib', specifier.slice(5))
      : /^\.{1,2}\//.test(specifier) ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)) : undefined;
    return candidate && snapshot.ids.has(candidate) ? candidate : undefined;
  };
  // a specifier the guard need not follow: a builtin, a SvelteKit virtual module or a package the manifest declares
  const external = (snapshot, raw) => {
    const specifier = unquery(raw);
    return isBuiltin(specifier) || /^\$(?:app|env)\//.test(specifier) || specifier === '$service-worker'
      || (!/^[./$#]/.test(specifier) && snapshot.declared.has(specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')));
  };
  // the module a specifier binds to at HEAD, as reachesFramework follows an import into it
  const targets = new Map();
  const exporter = (file, specifier) => {
    if (!targets.has(`${file}\0${specifier}`)) {
      const target = link(currentClosure, file, specifier);
      const text = target && runnableOf(target, source(head, target));
      targets.set(`${file}\0${specifier}`, text === undefined ? undefined : { file: target, text });
    }
    return targets.get(`${file}\0${specifier}`);
  };
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
  // A protected test file is judged against each of its references in turn: the named tests stay as reviewed (above)
  // whatever the base holds, and the rest of the file may be the base's change, or change after its last named test.
  const judge = (file, reference) => {
    const snapshot = snapshotAt(reference);
    if (snapshot.found.get(file) !== currentClosure.found.get(file) && fromBase(file)) {
      inherited.push(file);
      return;
    }
    const names = new Set(findings.tests.filter(entry => entry.file === file).map(entry => entry.name));
    const reviewed = statements(file, snapshot.found.get(file), names).list;
    const { list: current, tree, checker } = statements(file, currentClosure.found.get(file), names);
    const seen = new Set(reviewed.map(statement => statement.text));
    const fixed = list => JSON.stringify(list.filter(statement => !statement.free).map(statement => statement.text));
    if (fixed(reviewed) !== fixed(current.filter(statement => !(statement.isImport && !seen.has(statement.text))))) {
      throw Error(`protected test file changed outside its free tests (imports, helpers, mocks, hooks and the named tests stay as reviewed): ${file}${against(reference)}`);
    }
    // Tests in a file run in order, so nothing may change up to the last named test: a free test placed, changed or
    // dropped before it could set or clear state the named test reads.
    const prefix = list => JSON.stringify(list.slice(0, list.findLastIndex(statement => statement.holdsNamed) + 1)
      .filter(statement => !statement.isImport).map(statement => statement.text));
    if (prefix(reviewed) !== prefix(current)) {
      throw Error(`protected test file changed before its last named test (free tests may change only after it): ${file}${against(reference)}`);
    }
    const added = current.filter(statement => !seen.has(statement.text));
    const free = list => JSON.stringify(list.filter(statement => statement.free).map(statement => statement.text));
    if (free(reviewed) === free(current) && !added.some(statement => statement.isImport)) return;
    if (!reasonFor(file)) throw Error(`protected dependency changed: ${file}${against(reference)}; a free test change or a new import needs explicit assertion count reasons in assertionCountReasons[file]`);
    // A new import runs its module, and every module that one loads, before the named tests. It may name a module the
    // reviewed test already loads, or an unchanged module under test that, followed through its imports, does nothing
    // while it is imported and never reaches the test framework. A side-effect import refuses.
    const target = (resolved, file, specifier) => {
      const found = resolved(file, specifier);
      if (!found && isLocal(specifier)) throw Error(`unresolved local protected import ${specifier} in ${file}`);
      return found ?? `package:${specifier}`;
    };
    const imported = new Set(reviewed.filter(statement => statement.isImport)
      .map(statement => target(snapshot.resolve, file, statement.node.moduleSpecifier.text)));
    const loadedHere = snapshot.loadedBy(file);
    const evaluated = new Set([...imported, ...loadedHere]);
    const quiet = (specifier, module, visited) => {
      if (visited.has(module) || evaluated.has(module)) return;
      visited.add(module);
      const refuse = why => {
        throw Error(`new import ${specifier} in ${file} runs code at import time before the named tests (${why}); only a module the reviewed test already loads, or modules with no top-level effects, may be added`);
      };
      if (module.startsWith('package:')) {
        if (!isBuiltin(module.slice('package:'.length))) refuse(`${module.slice('package:'.length)} is a package the reviewed test does not load, whose import-time effects cannot be inspected`);
        return;
      }
      const script = scriptOf(module, source(head, module));
      if (script === undefined) return;
      const reach = reachesFramework(module, runnableOf(module, source(head, module)), exporter);
      if (reach) throw Error(`new import in ${file} loads ${module}, which reaches the test framework (${reach})`);
      const effect = importTimeEffect(module, script);
      if (effect) refuse(effect);
      const tree = ts.createSourceFile(module, script, ts.ScriptTarget.Latest, true);
      const typeOnly = tree.statements.filter(node => (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)
        || (ts.isExportDeclaration(node) && node.isTypeOnly)).map(node => node.moduleSpecifier?.text);
      for (const next of importsOf(tree, module)) {
        if (typeOnly.includes(next)) typeOnly.splice(typeOnly.indexOf(next), 1); // erased: loads nothing
        else quiet(specifier, target(currentClosure.resolve, module, next), visited);
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
      if (imported.has(module)) continue;
      if (isEntry(module)) throw Error(`new import ${specifier} in ${file} loads the test file ${module}`);
      if (loadedHere.has(module)) continue;
      if (module.startsWith('package:') || isSupport(module) || !exists(reference, module)
          || snapshot.ids.get(module) !== currentClosure.ids.get(module)) {
        throw Error(`new import ${specifier} in ${file} must name a module the reviewed file imports, a protected helper or an unchanged module under test${against(reference)}`);
      }
      quiet(specifier, module, new Set());
    }
  };
  for (const file of starts) for (const reference of references(file)) judge(file, reference);
  // Everything else in the closure (helpers, fixtures, resolver and runner configuration, setup files, test scripts)
  // stays as each reference holds it: as reviewed, and as the base holds a path it changed after the review, whichever
  // reference's closure protects that path. No reason excuses a change there.
  const dependency = (file, origin, oldText, newText, reference) => {
    // A runner configuration or derived package entry can be absent at review because the merged base added its file.
    // Protected membership takes precedence over runner membership: those origins need a genuine arrival, even
    // through transitive/cyclic runner imports. Both rules require the full trusted origin's blob and mode.
    if (oldText === undefined && newText !== undefined && !oldClosure.ids.has(origin)
        && (currentClosure.protectedDeps.has(origin) ? trustedArrival(origin)
          : (currentClosure.runner.has(origin) || file !== origin) && fromBase(origin))) {
      inherited.push(file);
      return;
    }
    if (oldText === undefined || newText === undefined) throw Error(`protected dependency added/deleted: ${file}${against(reference)}`);
    if (tokens(oldText) === tokens(newText)) return;
    if (fromBase(origin)) {
      inherited.push(file);
      return;
    }
    if (JSON.stringify(controlFlow(file, oldText)) !== JSON.stringify(controlFlow(file, newText))) {
      throw Error(`protected dependency control flow changed (return/conditional/wrapping): ${file}${against(reference)}`);
    }
    throw Error(`protected dependency changed: ${file}${against(reference)}; a recorded reason cannot excuse a helper, fixture, configuration or setup change`);
  };
  for (const file of new Set([...oldClosure.found.keys(), ...currentClosure.found.keys()])) {
    if (!starts.includes(file)) dependency(file, currentClosure.origin(file), oldClosure.found.get(file), currentClosure.found.get(file), base);
  }
  for (const reference of changers) {
    const snapshot = snapshotAt(reference);
    for (const file of new Set([...oldClosure.found.keys(), ...snapshot.found.keys(), ...currentClosure.found.keys()])) {
      const origin = [currentClosure, snapshot, oldClosure].find(each => each.found.has(file)).origin(file);
      if (starts.includes(file) || !baseCopies(origin).includes(reference)) continue;
      dependency(file, origin, entryAt(reference, file, origin), entryAt(head, file, origin), reference);
    }
  }
  for (const file of oldClosure.data) {
    if (currentClosure.ids.get(file) === oldClosure.ids.get(file)) continue;
    if (!currentClosure.ids.has(file) || !fromBase(file)) throw Error(`protected fixture changed or deleted: ${file}`);
    inherited.push(file);
  }
  // A fixture the base added or changed after the review keeps the base's copy that HEAD received, not the fix base's,
  // whichever reference's closure protects it; the branch may add its own.
  for (const reference of changers) {
    for (const file of new Set([...oldClosure.data, ...currentClosure.data, ...snapshotAt(reference).data, ...reverted.filter(currentClosure.fixture)])) {
      if (baseCopies(file).includes(reference) && treeEntry(reference, file) !== treeEntry(head, file)) {
        throw Error(`protected fixture changed or deleted: ${file}${against(reference)}; HEAD does not hold the base's copy`);
      }
    }
  }
  // A fix may change the module under test freely, but a matcher, spy or global installed from code the named test
  // loads changes what every test proves. Any changed module outside the protected closure and the runner can be
  // loaded that way, the module under test and the test-support files it loads alike, so none may reach the test
  // framework, and none may newly load a test file or support code that does. Test files are collected as entries of
  // their own, so they are left to the assertion count below.
  const compared = new Set([...oldClosure.found.keys(), ...currentClosure.found.keys(), ...protectedFiles]);
  // Test files are left to their assertion counts only while the runner isolates each: Vitest and Jest do by default,
  // bun's runner does not, nor does a configuration or test script that turns isolation off or shares one worker.
  // Runner code is read without its comments; a test script counts as running bun test only as a command.
  const SHARED = /\bisolate\s*:\s*false\b|--no-isolate\b|--isolate[= ]false\b|\bsingle(?:Fork|Thread)\s*:\s*true\b|--(?:[\w.]+\.)?single(?:Fork|Thread)\b/;
  const code = (file, text) => (supported(file) ? JSON.parse(tokens(text)).join(' ') : text.replace(/#[^\n"']*$/gm, ''));
  const shares = [oldClosure, currentClosure].flatMap(snapshot => [
    ...[...snapshot.runner].map(file => SHARED.exec(code(file, snapshot.found.get(file)))?.[0]),
    ...JSON.parse(snapshot.found.get('package.json#scripts') ?? '[]').map(([, script]) => SHARED.exec(script)?.[0]
      ?? (/(?:^|[;&|(]\s*)bun\s+test\b/.test(script) ? `bun test in ${script}` : undefined))]).find(Boolean)
    ?? (starts.some(file => importsOf(ts.createSourceFile(file, currentClosure.found.get(file), ts.ScriptTarget.Latest, true), file, false)
      .some(specifier => /^bun:test$/.test(specifier))) ? 'the named tests run under bun:test' : undefined);
  // The test files a module that is not itself a test file loads by a literal specifier, with that module.
  const importers = new Map();
  const entryImporters = (revision, snapshot) => {
    if (!importers.has(revision)) {
      const found = new Map();
      // every tracked script, since an alias (package.json imports, a tsconfig path) need not spell the test file's name
      for (const [file, mode] of snapshot.modes) {
        if (isEntry(file) || !REGULAR.includes(mode) || !/\.(?:[cm]?[jt]sx?|svelte)$/.test(file)
            || file.split('/').some(part => part === 'RAWS' || part === '.local')) continue;
        let script;
        try { script = scriptOf(file, source(revision, file)); } catch { continue; } // a component that does not parse loads nothing
        if (script === undefined) continue;
        for (const specifier of importsOf(ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true), file, false)) {
          const target = link(snapshot, file, specifier);
          if (target && isEntry(target) && !found.has(target)) found.set(target, file);
        }
      }
      importers.set(revision, found);
    }
    return importers.get(revision);
  };
  const walked = new Set();
  const loadsSupport = (from, module) => {
    if (walked.has(module) || !isSupport(module)) return; // the module under test is not followed
    if (isEntry(module)) throw Error(`changed module ${from} newly loads the test file ${module}`);
    walked.add(module);
    const script = scriptOf(module, source(head, module));
    if (script === undefined) return;
    const reach = reachesFramework(module, runnableOf(module, source(head, module)), exporter);
    if (reach) throw Error(`changed module ${from} newly loads ${module}, which reaches the test framework (${reach})`);
    for (const specifier of importsOf(ts.createSourceFile(module, script, ts.ScriptTarget.Latest, true), module)) {
      const next = link(currentClosure, module, specifier);
      if (next) loadsSupport(from, next);
      else if (isLocal(specifier) && !external(currentClosure, specifier)) throw Error(`changed module ${from} newly loads ${module}, whose local import ${specifier} cannot be inspected`);
    }
  };
  const loads = (revision, snapshot, file) => {
    const script = exists(revision, file) ? scriptOf(file, source(revision, file)) : undefined;
    if (script === undefined) return new Set();
    const tree = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true);
    return new Set(importsOf(tree, file, false).map(specifier => link(snapshot, file, specifier)).filter(Boolean));
  };
  for (const file of touched) {
    if (compared.has(file) || CONFIG_FILE.test(file) || oldClosure.runner.has(file) || currentClosure.runner.has(file)
        || !exists(head, file)) continue;
    if (isEntry(file) && shares) throw Error(`changed test file ${file} runs in the named tests' process, because test files are not isolated (${shares}); the guard cannot bound it`);
    if (isEntry(file)) {
      // a test file the runner collects as an entry of its own, unless a module that is not a test file loads it too
      const importer = entryImporters(base, oldClosure).get(file) ?? entryImporters(head, currentClosure).get(file);
      if (importer) throw Error(`changed test file ${file} is loaded by ${importer}, which is not a test file, so the runner does not isolate it from that module; the guard cannot bound it`);
      continue;
    }
    const script = scriptOf(file, source(head, file));
    const reach = script === undefined ? undefined : reachesFramework(file, runnableOf(file, source(head, file)), exporter);
    if (reach) throw Error(`changed module outside the protected closure reaches the test framework (${reach}): ${file}`);
    // every literal specifier it loads binds to a tracked file, a builtin or a declared package; none is skipped
    if (script !== undefined) {
      for (const specifier of importsOf(ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true), file, false, false)) {
        if (!link(currentClosure, file, specifier) && !external(currentClosure, specifier)) {
          throw Error(`changed module ${file} imports ${specifier}, which binds to no tracked file, declared package or builtin; the guard fails closed`);
        }
      }
    }
    // a load is new when one of the module's references does not make it
    const reviewed = references(file).map(reference => loads(reference, snapshotAt(reference), file));
    for (const target of loads(head, currentClosure, file)) if (reviewed.some(loaded => !loaded.has(target))) loadsSupport(file, target);
  }
  // Git's merge of the fix base with a base copy: what an unchanged branch merging that base commit holds, through any
  // number of merge bases. Its objects go to a scratch directory, never to the repository.
  const merges = new Map();
  const mergedWith = revision => {
    if (!merges.has(revision)) {
      const scratch = mkdtempSync(path.join(tmpdir(), 'test-guard-merge-'));
      process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
      const objects = { ...env, GIT_OBJECT_DIRECTORY: scratch,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: git('rev-parse', '--path-format=absolute', '--git-path', 'objects').trim() };
      const show = (...words) => execFileSync('git', ['-C', root, ...words], { env: objects, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      const result = spawnSync('git', ['-C', root, 'merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', base, revision],
        { env: objects, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      if (result.status !== 0 && result.status !== 1) {
        throw Error(`git merge-tree ${base.slice(0, 12)} ${revision.slice(0, 12)} failed: ${(result.stderr || String(result.error)).trim()}`);
      }
      const [tree, ...conflicted] = result.stdout.split('\0').filter(Boolean);
      merges.set(revision, { conflicted: new Set(conflicted),
        copy: file => (show('ls-tree', '-z', tree, '--', file) ? show('show', `${tree}:${file}`) : undefined) });
    }
    return merges.get(revision);
  };
  // a base change the branch undid is no difference from the fix base, but it loses the base's assertions
  for (const file of touched) {
    if (!(/(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\./.test(file))) continue;
    if (!supported(file)) {
      if (/\.(?:py|sh)$/.test(file)) throw Error(`unsupported changed test syntax: ${file}; guard refuses to infer assertion counts`);
      continue;
    }
    // A path the base changed after the review counts at least the assertions of Git's merge of the fix base's copy with
    // the base's copy HEAD received, whatever the branch did with the merge. Where the two copies conflict, the branch
    // resolved them by hand: the floor is then the fix base's count plus the base copy's over the merge bases' (0 where
    // absent). Every floor is at least the fix base's count.
    const copies = baseCopies(file);
    const counted = revision => (treeEntry(revision, file) === undefined ? 0 : parse(file, source(revision, file)).assertions);
    const reviewed = exists(base, file) ? load(base, file).assertions : 0;
    const floors = copies.map(revision => {
      const copy = counted(revision); // an unreadable base copy fails closed here, before the merge
      const merge = mergedWith(revision);
      if (merge.conflicted.has(file)) return reviewed + Math.max(0, copy - Math.min(...forksOf(revision).map(counted)));
      const text = merge.copy(file);
      return text === undefined ? 0 : parse(file, text).assertions;
    });
    const old = Math.max(reviewed, ...floors);
    const current = exists(head, file) ? load(head, file).assertions : 0;
    if (current < old && !(typeof reasons[file] === 'string' && reasons[file].trim())) {
      throw Error(`assertion count fell in ${file}: ${old} -> ${current}${copies.length ? ` (the fix base's ${reviewed}; ${floors.join(', ')} with the base's change at ${copies.map(revision => revision.slice(0, 12)).join(', ')} merged)` : ''}; record assertionCountReasons[file]`);
    }
  }
  if (diff.length > changed.length) {
    console.log(`test-guard: ${diff.length - changed.length} changed file(s) are the base's, not this branch's: the base ${trusted} `
      + `is merged into HEAD and HEAD holds each as it does; protected among them: ${[...new Set(inherited)].join(', ') || 'none'}`);
  }
  console.log(`test-guard: PASS (${findings.tests.length} named tests${protectedFiles.size ? `; file protection: ${protectedFiles.size} frozen files` : ''}; ${base}..${head}${trusted ? `; trusted base ${trusted}` : ''})`);
  return proceed();
}
try { process.exitCode = main(); }
catch (error) { console.error(`test-guard: FAIL. ${error.message}`); process.exitCode = 1; }
