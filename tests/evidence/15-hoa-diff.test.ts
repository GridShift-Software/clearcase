import { afterAll, beforeAll, expect, test } from 'vitest';
import { load } from '../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/hoa_diff_tab/+page.server.ts';
import { builtCase, CASE_ID, locals, published, type BuiltCase, type Deployment } from '../publication/shards/world.ts';

let b: BuiltCase, dep: Deployment;
beforeAll(async () => { b = await builtCase(); dep = await published(b); }, 120_000);
afterAll(() => b?.cleanup());
const view = (query: string) => load({ locals: locals(dep), params: { caseId: CASE_ID, version: b.built.record.resultsVersion }, url: new URL(`https://example.invalid/${query}`) } as never);

test('hosted diff offers excerpts, compares chosen documents and rejects unknown refs', async () => {
 const idle = await view('');
 expect(idle.candidates.length).toBeGreaterThan(1);
 expect(idle.result).toEqual({ kind: 'none' });
 const [a, b] = idle.candidates;
 const compared = await view(`?a=${encodeURIComponent(a!.ref)}&b=${encodeURIComponent(b!.ref)}&mode=lines`);
 expect(compared.result).toMatchObject({ kind: 'diff', mode: 'lines', a: { ref: a!.ref }, b: { ref: b!.ref } });
 const unknown = await view(`?a=UNKNOWN&b=${encodeURIComponent(b!.ref)}`);
 expect(unknown.result).toMatchObject({ kind: 'pick', reasons: ['Document A “UNKNOWN” is not a document of this results version.'] });
});
