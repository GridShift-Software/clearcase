// The contract page names every diagnostic code with its registered severity.
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { CODES } from '../../src/lib/case-package/codes.ts';

it('docs/results-package.md lists every diagnostic code with its severity and class', async () => {
  const doc = await readFile('docs/results-package.md', 'utf8');
  for (const [code, d] of Object.entries(CODES)) expect(doc, code).toContain(`| \`${code}\` | ${d.severity} | ${d.cls} |`);
});
