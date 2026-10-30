// GRS-280: a note is deleted only once its Delete is confirmed for that note, as a register row is (GRS-175). The local
// document page's real note and delnote actions on a synthetic case, and the no-JavaScript answer the shared document
// page and the hosted case notes page render. Server renders and a local store only: no browser or hosted run.
process.env.TZ = 'UTC';
import path from 'node:path';
import { render } from 'svelte/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCase } from '../e2e/pilot/lib/fixtures';
import type { LocalCase } from '../../src/lib/local-case/service.server';
import { ackFor, cleanup, tempRoot } from '../../src/lib/local-case/test-support';

vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
vi.mock('$app/navigation', () => ({ invalidateAll: () => Promise.resolve() }));
const { default: DocPage } = await import('../../src/routes/v/[vid]/doc/[ref]/+page.svelte');
const { default: NotesPage } = await import('../../deploy/client/routes/cases/[caseId]/notes/+page.svelte');

let root: string, lc: LocalCase, rv: string, ref: string;
let D: typeof import('../../src/routes/v/[vid]/doc/[ref]/+page.server');
const env = { ...process.env };
beforeAll(async () => {
	root = await tempRoot('note-delete-confirm');
	Object.assign(process.env, { CLEARCASE_DATA_DIR: path.join(root, 'data'), PORT: '1', CLEARCASE_USERWORK_BACKUP_DELAY_MS: '60000' });
	const { app } = await import('../../src/lib/local-case/app.server');
	D = await import('../../src/routes/v/[vid]/doc/[ref]/+page.server');
	lc = app();
	const lock = lc.storage.acquireInstanceLock();
	if (!lock.ok) throw new Error(lock.reason);
	await lc.startup();
	const c = await buildCase(path.join(root, 'c'));
	const imp = await lc.importPackage(c.caseDir, c.pkgDir);
	expect(await lc.activate(c.resultsVersion, ackFor(lc, imp.importId))).toBeNull();
	rv = c.resultsVersion;
	ref = (JSON.parse(lc.store.chronologyJson(rv)!) as { ref: string }[]).find((r) => lc.store.document(rv, r.ref))!.ref;
}, 120_000);
afterAll(async () => {
	const g = globalThis as { __clearcase?: { app: LocalCase } };
	g.__clearcase?.app.shutdown();
	delete g.__clearcase;
	process.env = env;
	if (root) await cleanup(root);
});

const post = (action: 'note' | 'delnote', fields: Record<string, string>) => {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	return { params: { vid: rv, ref }, request: new Request(`http://127.0.0.1/v/${encodeURIComponent(rv)}/doc/${ref}?/${action}`, { method: 'POST', body }) } as never;
};
const noteIds = () => lc.userWork.notesFor(lc.store.getVersion(rv)!.case_id, rv, ref).map((n) => n.id);

describe('280 local document page: delnote deletes only a note confirmed for itself', () => {
	it('no confirmation, one for another note, an empty one, or a Cancel deletes nothing; the page asks, or after Cancel does not', async () => {
		expect(await D.actions.note!(post('note', { body: 'Synthetic note kept until confirmed' }))).toEqual({ saved: true });
		expect(await D.actions.note!(post('note', { body: 'Synthetic other note' }))).toEqual({ saved: true });
		const [id, other] = noteIds() as [string, string];
		for (const [extra, confirm] of [[{}, id], [{ confirm: other }, id], [{ confirm: '' }, id], [{ cancel: id }, null], [{ cancel: id, confirm: id }, null]] as const) {
			expect(await D.actions.delnote!(post('delnote', { id, version: '', operationId: 'op-1', ...extra })), JSON.stringify(extra)).toMatchObject({ status: 400, data: { op: 'delete', confirm } });
			expect(noteIds()).toContain(id);
		}
		expect(await D.actions.delnote!(post('delnote', { id, version: '', operationId: 'op-1', confirm: id }))).toEqual({ deleted: true });
		expect(noteIds()).toEqual([other]);
	});
});

const VERSION = { id: `sha256:${'b'.repeat(64)}`, titleName: 'Synthetic v Example' };
const fields = { date: '', dateType: null, dateSource: null, subject: 'Synthetic document', filename: 'synthetic.pdf', docType: '', bundle: '', sender: '', to: '', cc: '', amount: '', invoiceNo: '', size: null, textStatus: '', alsoIn: [], attachmentNames: [], excerpt: '' };
const docNote = (id: string) => ({ id, body: `Synthetic note ${id}`, createdAt: '2026-11-01', status: 'here', refAtCreation: 'D-001', candidates: [], intact: true, version: 'v1' });
const doc = {
	ref: 'D-001', source: 'results', version: VERSION, fields, base: '/cases/c1/v', page: null, attachments: [], children: [], related: [], parent: null, onDisk: null, operationId: 'op-1',
	state: { file: 'missing', original: null, self: null, flags: [] }, links: { presentation: null, open: null, download: null, viewer: null }, notes: [docNote('n-1'), docNote('n-2')],
};
const caseNotes = (form: unknown) => render(NotesPage, { props: { form, data: { caseId: 'c1', label: 'Synthetic case', caseHref: '/cases/c1', chronologyHref: null, resultsVersion: null, operationId: 'op-1', saved: false, deleted: false, canWrite: true,
	notes: { state: 'available', items: ['n-1', 'n-2'].map((id) => ({ id, version: 'v1', body: `Synthetic note ${id}`, createdAt: '2026-11-01', target: { kind: 'case' } })) } } } as never }).body;
const docPage = (form: unknown) => render(DocPage as never, { props: { data: doc, form } as never }).body;
/** The markup of one note's delete form. */
const formOf = (body: string, id: string) => body.slice(body.indexOf(`value="${id}"`), body.indexOf('</form>', body.indexOf(`value="${id}"`)));

describe('280 without JavaScript the page asks before a note is deleted', () => {
	for (const [page, html] of [['the shared document page', docPage], ['the hosted case notes page', caseNotes]] as const) {
		it(`${page}: Delete posts no confirmation, and the server's ask shows Confirm delete and Cancel for that note only`, () => {
			const first = html(null);
			for (const id of ['n-1', 'n-2']) {
				expect(formOf(first, id)).toContain('>Delete</button>');
				expect(formOf(first, id)).not.toContain('name="confirm"');
			}
			const asked = html({ op: 'delete', confirm: 'n-1' });
			expect(formOf(asked, 'n-1')).toContain('data-confirming="n-1"');
			expect(formOf(asked, 'n-1')).toContain('name="confirm" value="n-1"');
			expect(formOf(asked, 'n-1')).toContain('name="cancel" value="n-1"');
			expect(formOf(asked, 'n-1')).toContain('Delete this note?');
			expect(formOf(asked, 'n-2')).not.toContain('name="confirm"');
			expect(asked).not.toContain('role="alert"');
			const cancelled = html({ op: 'delete', confirm: null });
			expect(cancelled).not.toContain('data-confirming');
			expect(cancelled).not.toContain('role="alert"');
		});
	}
});
