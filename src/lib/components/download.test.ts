import { afterEach, expect, it, vi } from 'vitest';
import { download, toCSV } from './csv.ts';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('downloads identical fixture bytes through the CSV string and bundle binary paths, with their names, types and delayed cleanup', async () => {
	vi.useFakeTimers();
	const blobs: Blob[] = [];
	vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
		if (!(blob instanceof Blob)) throw new Error('Expected a Blob');
		blobs.push(blob);
		return `blob:fixture-${blobs.length}`;
	});
	const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
	const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
	const append = vi.fn();
	vi.stubGlobal('document', { createElement: vi.fn(() => anchor), body: { append } });
	const csv = toCSV([['Name', 'Amount'], ['Synthetic café', '12.50']]);
	const bytes = new TextEncoder().encode(csv);
	const binary = new Uint8Array([9, 0, 255, 128, 13, 10, 9]).subarray(1, 6);
	const cases = [
		{ name: 'rows.csv', content: csv, type: undefined, mime: 'text/csv;charset=utf-8', bytes },
		{ name: 'index.docx', content: bytes, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes },
		{ name: 'cover.html', content: csv, type: 'text/html', mime: new Blob([csv], { type: 'text/html' }).type, bytes },
		{ name: 'index.pdf', content: binary, type: 'application/pdf', mime: 'application/pdf', bytes: binary },
	];
	for (const [i, fixture] of cases.entries()) {
		download(fixture.name, fixture.content, fixture.type);
		expect(anchor.href).toBe(`blob:fixture-${i + 1}`);
		expect(anchor.download).toBe(fixture.name);
		expect(blobs[i]!.type).toBe(fixture.mime);
		expect(new Uint8Array(await blobs[i]!.arrayBuffer())).toEqual(fixture.bytes);
	}
	expect(await blobs[0]!.arrayBuffer()).toEqual(await blobs[1]!.arrayBuffer());
	expect(append).toHaveBeenCalledTimes(cases.length);
	expect(anchor.click).toHaveBeenCalledTimes(cases.length);
	expect(anchor.remove).toHaveBeenCalledTimes(cases.length);
	vi.advanceTimersByTime(999);
	expect(revoke).not.toHaveBeenCalled();
	vi.advanceTimersByTime(1);
	expect(revoke.mock.calls).toEqual(cases.map((_, i) => [`blob:fixture-${i + 1}`]));
});
