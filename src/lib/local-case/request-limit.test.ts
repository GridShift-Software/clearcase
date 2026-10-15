import { describe, expect, it } from 'vitest';
import { REQUEST_LIMIT } from '$lib/views/litigation/submit';
import { MAX_BACKUP_BYTES } from '$lib/user-work/backup/backup.server';
import { BACKUP_BODY_LIMIT, COURT_BUNDLE_BODY_LIMIT, DEFAULT_BODY_LIMIT, bodyLimit, discardBody, oversize } from './request-limit.server.ts';

const req = (method: string, headers: Record<string, string> = {}) => ({ method, headers: new Headers(headers) });
const LIT = '/v/abc/litigation/heads_tab';
const BACKUP = '/v/abc/system/backup_tab';
const COURT = '/v/abc/bundles/court_bundle_tab';

describe('oversize()', () => {
	it('the default is the 512 KiB the litigation message names', () => {
		expect(`${DEFAULT_BODY_LIMIT / 1024} KiB`).toBe(REQUEST_LIMIT);
	});
	it('a form post over the limit is 413 and names the limit; one at the limit is read', () => {
		expect(oversize(req('POST', { 'content-length': String(DEFAULT_BODY_LIMIT + 1) }), LIT)).toEqual({ status: 413, message: 'request too large: this page accepts at most 512 KiB in one request' });
		expect(oversize(req('POST', { 'content-length': String(DEFAULT_BODY_LIMIT) }), LIT)).toBeNull();
	});
	it('every route but backup restore has the default limit; restore takes a backup file and its form', () => {
		for (const p of ['/v/abc/registers/x', '/v/abc/quantum/payments_tab', '/v/abc/bundles/discovery_tab', '/v/abc/doc/D1', '/import', '/recovery', '/v/abc/system/backup_tab/download', '/v/abc/system/rescan_tab']) expect(bodyLimit(p)).toBe(DEFAULT_BODY_LIMIT);
		expect(bodyLimit(BACKUP)).toBe(BACKUP_BODY_LIMIT);
		expect(BACKUP_BODY_LIMIT).toBeGreaterThan(MAX_BACKUP_BYTES);
		expect(oversize(req('POST', { 'content-length': String(MAX_BACKUP_BYTES) }), BACKUP)).toBeNull();
		expect(oversize(req('POST', { 'content-length': String(BACKUP_BODY_LIMIT + 1) }), BACKUP)?.status).toBe(413);
	});
	it('the court bundle page takes 2 MiB (its own item-list cap is 2,000,000 characters), no other bundle page does', () => {
		expect(COURT_BUNDLE_BODY_LIMIT).toBe(2 * 1024 * 1024);
		expect(bodyLimit(COURT)).toBe(COURT_BUNDLE_BODY_LIMIT);
		expect(bodyLimit(`${COURT}/`)).toBe(COURT_BUNDLE_BODY_LIMIT);
		for (const p of ['/v/abc/bundles/discovery_tab', '/v/abc/bundles/caselines_tab', '/v/abc/bundles/court_bundle_tab/x', '/v/abc/other/court_bundle_tab', '/v/a/b/bundles/court_bundle_tab']) expect(bodyLimit(p)).toBe(DEFAULT_BODY_LIMIT);
		expect(oversize(req('POST', { 'content-length': '1000000' }), COURT)).toBeNull();
		expect(oversize(req('POST', { 'content-length': String(COURT_BUNDLE_BODY_LIMIT) }), COURT)).toBeNull();
		expect(oversize(req('POST', { 'content-length': String(COURT_BUNDLE_BODY_LIMIT + 1) }), COURT)).toEqual({ status: 413, message: 'request too large: this page accepts at most 2 MiB in one request' });
		expect(oversize(req('POST', { 'content-length': '1000000' }), '/v/abc/bundles/discovery_tab')?.status).toBe(413);
	});
	it('a body of undeclared or unreadable size is 411, not read; no body and reads pass', () => {
		expect(oversize(req('POST', { 'transfer-encoding': 'chunked' }), LIT)?.status).toBe(411);
		expect(oversize(req('POST', { 'content-length': '12abc' }), LIT)?.status).toBe(411);
		expect(oversize(req('POST', { 'content-length': '-5' }), LIT)?.status).toBe(411);
		expect(oversize(req('POST'), LIT)).toBeNull();
		expect(oversize(req('GET', { 'content-length': '99999999' }), LIT)).toBeNull();
	});
});

describe('discardBody()', () => {
	it('reads an over-limit body to its end without keeping it, and ends quietly with no body or a failing stream', async () => {
		let pulled = 0;
		const chunks = new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(c) { if (pulled++ < 4) c.enqueue(new Uint8Array(1000)); else c.close(); } });
		await discardBody({ body: chunks });
		expect(pulled).toBe(5);
		await discardBody({ body: null });
		await discardBody({ body: new ReadableStream({ pull(c) { c.error(new Error('reset')); } }) });
	});
});
