// Source closure only: no workerd, provider or deployed-artifact claim.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('uses real canonical validator/storage and no filesystem, SDK, network, process, processing or extra host modules', () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const entry = path.join(root, 'src/lib/server/runtime/hosted/candidate-stager.ts');
  const seen = new Set<string>(), externals = new Set<string>();
  function walk(file: string) {
    if (seen.has(file)) return;
    seen.add(file);
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function dependency(spec: ts.Expression) {
      expect(ts.isStringLiteral(spec)).toBe(true);
      if (!ts.isStringLiteral(spec)) return;
      const name = spec.text;
      if (!name.startsWith('.')) {
        externals.add(name);
        expect(['node:crypto', 'typebox', 'typebox/value']).toContain(name);
        // The only host imports are in the existing canonical helpers, not this factory or adapters.
        if (name === 'node:crypto') expect(file).toMatch(/\/case-package\/(hash|diagnostics|reader)\.ts$/);
      } else {
        const next = path.resolve(path.dirname(file), name);
        expect(next.startsWith(path.join(root, 'src/lib/'))).toBe(true);
        expect(next).not.toMatch(/\/local-case\/|\/case-package\/(index|import|originals|source|writer|zip)\.ts$|\/case-package\/v5\/|\/processing\//);
        walk(next);
      }
    }
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node)) {
        const c = node.importClause;
        const onlyTypes = c && !c.name && c.namedBindings && ts.isNamedImports(c.namedBindings) && c.namedBindings.elements.every((n) => n.isTypeOnly);
        if (!c?.isTypeOnly && !onlyTypes) dependency(node.moduleSpecifier);
        return; // Do not mistake an erased type's name for executable access.
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) dependency(node.moduleSpecifier);
      if (ts.isCallExpression(node)) {
        expect(node.expression.kind).not.toBe(ts.SyntaxKind.ImportKeyword);
        if (ts.isIdentifier(node.expression)) expect(['fetch', 'require', 'eval', 'setTimeout', 'setInterval']).not.toContain(node.expression.text);
      }
      if (ts.isIdentifier(node)) expect(['Bun', 'process', 'XMLHttpRequest', 'WebSocket']).not.toContain(node.text);
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  walk(entry);
  for (const suffix of ['case-package/hosted-validation.ts', 'case-package/validate.ts', 'storage/cloud/staging.ts', 'storage/cloud/original-facts.ts', 'storage/cloud/verification.ts', 'results-review/native/repository.ts', 'submissions/repository.ts']) {
    expect(seen.has(path.join(root, 'src/lib', suffix))).toBe(true);
  }
  expect([...externals].sort()).toEqual(['node:crypto', 'typebox', 'typebox/value']);
});
