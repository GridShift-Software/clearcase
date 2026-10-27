import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { GET as views } from '../../../deploy/client/routes/cases/[caseId]/views/+server';
import { GET as originals } from '../../../deploy/client/routes/cases/[caseId]/originals/+server';
import { CASE, event, fake } from './doubles';

it.each([views, originals])('returns a navigable 404 for an unpublished case, and refuses unknown cases', async (get) => {
  const f = fake({ publication: { kind: 'none' } });
  const response = await get(event(f.services, { caseId: CASE }));
  expect(response.status).toBe(404);
  expect(await response.text()).toContain(`href="/cases/${CASE}"`);
  expect(f.calls[0]).toBe('getCase');
  const missing = fake({ missingCase: true });
  await expect(get(event(missing.services, { caseId: CASE }))).rejects.toMatchObject({ status: 404 });
});

it('bounds controls and wraps long content, including the mobile chronology', () => {
  const layout = readFileSync('deploy/client/routes/+layout.svelte', 'utf8');
  const preview = readFileSync('deploy/client/routes/operator/cases/[caseId]/preview/[candidateId]/+page.svelte', 'utf8');
  const viewer = readFileSync('src/lib/viewer/hosted/PdfViewer.svelte', 'utf8');
  expect(layout).toMatch(/textarea[^}]*max-width:\s*100%/);
  expect(layout).toMatch(/overflow-wrap:\s*anywhere/);
  expect(preview).toMatch(/@media[^{}]+max-width/);
  expect(preview).toMatch(/td[^{}]*display:\s*block/);
  expect(viewer).toMatch(/overflow-x:\s*auto/);
});
