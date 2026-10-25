// This is a source-graph check, not a workerd/provider acceptance claim.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('has no runtime filesystem, source/import barrel, SDK, network, process or recipe dependency', () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const entry = path.join(root, 'src/lib/case-package/hosted-validation.ts');
  const seen = new Set<string>();
  const externals = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const dependency = (specifier: ts.Expression) => {
      expect(ts.isStringLiteral(specifier)).toBe(true);
      if (!ts.isStringLiteral(specifier)) return;
      const name = specifier.text;
      if (name.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), name);
        expect(resolved.startsWith(path.join(root, 'src/lib/case-package/'))).toBe(true);
        expect(resolved).not.toMatch(/\/(?:index|import|originals|source|writer|zip)\.ts$|\/v5\//);
        walk(resolved);
      } else {
        externals.add(name);
        // The canonical pure hashing helpers use Workers' allowed crypto builtin.
        // No direct Node/Bun import exists in the adapter itself.
        expect(['typebox', 'typebox/value', 'node:crypto']).toContain(name);
        if (file === entry) expect(name.startsWith('node:') || name.startsWith('bun:')).toBe(false);
      }
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        const c = node.importClause;
        const onlyNamedTypes = c && !c.name && c.namedBindings && ts.isNamedImports(c.namedBindings) && c.namedBindings.elements.every((e) => e.isTypeOnly);
        if (!c?.isTypeOnly && !onlyNamedTypes) dependency(node.moduleSpecifier);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) dependency(node.moduleSpecifier);
      if (ts.isCallExpression(node)) {
        expect(node.expression.kind).not.toBe(ts.SyntaxKind.ImportKeyword);
        if (ts.isIdentifier(node.expression)) expect(['fetch', 'require', 'eval', 'setTimeout', 'setInterval']).not.toContain(node.expression.text);
      }
      if (ts.isIdentifier(node)) expect(['Bun', 'process', 'XMLHttpRequest', 'WebSocket']).not.toContain(node.text);
      if (file === entry && ts.isPropertyAccessExpression(node)) expect(node.getText(ast)).not.toBe('Date.now');
      ts.forEachChild(node, visit);
    };
    visit(ast);
  };
  walk(entry);
  expect(seen.has(path.join(root, 'src/lib/case-package/validate.ts'))).toBe(true);
  expect(seen.has(path.join(root, 'src/lib/case-package/diagnostics.ts'))).toBe(true);
  expect(seen.has(path.join(root, 'src/lib/case-package/hash.ts'))).toBe(true);
  expect([...externals].sort()).toEqual(['node:crypto', 'typebox', 'typebox/value']);
});
