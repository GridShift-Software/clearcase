import { render } from 'svelte/server';
import { expect, it, vi } from 'vitest';
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
vi.mock('$app/navigation', () => ({ invalidateAll: () => Promise.resolve() }));
// Resolve the hosted wrapper's build alias to the real shared page in this test, without changing runner configuration.
vi.mock('$local/doc/[ref]/+page.svelte', async () => import('../../../src/routes/v/[vid]/doc/[ref]/+page.svelte'));
import Document from '../../../deploy/client/routes/cases/[caseId]/v/[version]/doc/[ref]/+page.svelte';

it('16 hosted document wrapper renders a stale-delete action answer from its form prop', () => {
  const data = {
    ref: 'D-001', source: 'results', version: { id: `sha256:${'a'.repeat(64)}`, titleName: 'Synthetic matter' },
    fields: { date: '', dateType: null, dateSource: null, subject: 'Synthetic document', filename: 'synthetic.pdf', docType: '', bundle: '', sender: '', to: '', cc: '', amount: '', invoiceNo: '', size: null, textStatus: '', alsoIn: [], attachmentNames: [], excerpt: '' },
    state: { file: 'missing', original: null, self: null, flags: [] },
    links: { presentation: null, open: null, download: null, viewer: null }, onDisk: null, page: null,
    attachments: [], children: [], related: [], parent: null, notes: [], operationId: 'synthetic-operation', base: '/cases/synthetic/v',
  };
  const form = { op: 'delete', values: null, message: 'This was changed by someone else. Reload the page and try again.', retry: false };
  const html = render(Document, { props: { data, form } as never }).body;
  expect(html).toContain('role="alert"');
  expect(html).toContain(form.message);
});
