// Sprint ticket 12: the shared document page states the three original states in words, and carries the journeys' hooks.
import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';

vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
const { default: Page } = await import('../../src/routes/v/[vid]/doc/[ref]/+page.svelte');

const RV = `sha256:${'b'.repeat(64)}`;
const BASE = '/cases/c1/v';
const ORIGINAL = { path: 'DOCS/D-1.pdf', sha256: 'a'.repeat(64), size: 9260, mediaType: 'application/pdf', status: 'verified' as const, downloadOnly: false };
const fields = { date: '2002-03-04', dateType: null, dateSource: null, subject: 'Synthetic', filename: 'D-1.pdf', docType: 'other', bundle: 'Original', sender: '', to: '', cc: '', amount: '', invoiceNo: '', size: null, textStatus: 'extracted', alsoIn: [], attachmentNames: [], excerpt: '' };
const data = (over: Record<string, unknown>) => ({
  version: { id: RV, titleName: 'Synthetic v Example' }, base: BASE, ref: 'D-1', source: 'results', fields, page: null, attachments: [], children: [], related: [], notes: [], onDisk: null,
  parent: null, links: { presentation: null, open: null, download: null, viewer: null }, state: { file: 'missing', preview: 'none', text: 'extracted', mediaType: 'application/pdf', flags: [], original: null, self: null }, ...over,
});
const html = (over: Record<string, unknown>) => render(Page as never, { props: { data: data(over), form: null } }).body;

describe('12 document page original states', () => {
  test('available: the metadata block holds the original, with Open and Download', () => {
    const out = html({ state: { file: 'present', preview: 'viewer', text: 'extracted', mediaType: 'application/pdf', flags: [], original: ORIGINAL, self: null }, links: { presentation: 'viewer', open: '/o', download: '/o?download=1', viewer: '/v' } });
    expect(out).toContain('data-testid="original-metadata"');
    expect(out).toContain('data-original-availability="available"');
    expect(out).toContain('id="open-original"');
    expect(out).toContain('9,260 bytes');
    expect(out).toContain('id="download-original"');
    expect(out).not.toContain('Original not supplied');
  });

  test('missing: "Original not supplied" and no Open', () => {
    const out = html({});
    expect(out).toContain('data-original-availability="missing"');
    expect(out).toContain('Original not supplied');
    expect(out).not.toContain('id="open-original"');
  });

  test('stored but not available now is reported as not supplied too', () => {
    const out = html({ state: { file: 'present', preview: 'viewer', text: 'extracted', mediaType: 'application/pdf', flags: [], original: ORIGINAL, self: null }, onDisk: 'not-found' });
    expect(out).toContain('data-original-availability="missing"');
    expect(out).not.toContain('id="open-original"');
  });

  test('embedded: "inside the parent message" with a link to the parent document page', () => {
    const out = html({ parent: { ref: 'EM-1', exists: true }, state: { file: 'missing', preview: 'none', text: 'pending', mediaType: 'image/png', flags: [], original: null, self: { route: 'parent', parentRef: 'EM-1', reason: null, via: 'EM-1' } } });
    expect(out).toContain('data-original-availability="embedded"');
    expect(out).toContain('inside the parent message');
    expect(out).toContain(`href="${BASE}/${encodeURIComponent(RV)}/doc/EM-1"`);
    expect(out).not.toContain('id="open-original"');
  });
});
