// PR #76 review, GRS-24 F1, same class as the 101-note finding: every list the validation report cuts short says so.
// The report page is rendered from an invented loader result; nothing here comes from a case.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import ImportPage from '../../src/routes/import/[id]/+page.svelte';

vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve() }));
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));

const ref = (n: number) => `ZZ-${String(n).padStart(3, '0')}`;
const diff = (ambiguous: number) => ({
  unchanged: 0, changedRows: [], renumbered: [], added: [], removed: [], unmatched: { candidate: 0 },
  ambiguous: Array.from({ length: ambiguous }, (_, i) => ({ base: [ref(i)], candidate: [ref(1000 + i)] })),
});
const page = (ambiguous: number) => {
  const data = {
    imp: { id: 7, at: '2026-10-08T09:00:00Z', caseFolder: '/invented/case', packageSource: '/invented/package', outcome: 'stored' },
    report: { verdict: 'accept', caseId: 'invented', caseLabel: 'Invented', resultsVersion: null, manifestSha256: null, diagnosticsSha256: '', validatorVersion: 'v', ms: 1, app: [], counts: {}, warnings: 0, errors: 0 },
    groups: [], newWarnings: [], knownWarnings: 0, vid: null, active: null, pruned: false, supersededBy: null, check: null,
    textCoverage: null, sourceCoverage: null, diff: diff(ambiguous), notes: null, noop: false, repaired: false,
  };
  const body = render(ImportPage, { props: { data, form: null } as never }).body;
  const at = body.indexOf('id="diff"');
  return body.slice(at, body.indexOf('</section>', at));
};

describe('the changes-against-the-active-version section of the validation report', () => {
  it('lists up to 20 ambiguous fingerprints without a truncation mark', () => {
    const s = page(20);
    expect(s).toContain(`${ref(19)} → ${ref(1019)}`);
    expect(s).not.toContain('…');
  });

  it('marks the cut when more than 20 fingerprints are ambiguous, and lists only the first 20', () => {
    const s = page(25);
    expect(s).toContain(`${ref(19)} → ${ref(1019)}`);
    expect(s).not.toContain(ref(20));
    expect(s).toContain('25 ambiguous fingerprints');
    expect(s).toMatch(/…/);
  });
});
