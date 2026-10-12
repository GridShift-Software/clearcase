// CC-09-r2 regressions (synthetic data): session uploads are octet-stream (D1) and the discovery write ops chunk a
// large selection under the body limit and keep the Retry ordering rule (D7). New modules, so this file does not load
// at 2e7dd60.
import { describe, expect, it } from 'vitest';
import { uploadBlob } from '../../src/lib/views/bundles/caselines';
import { CHUNK_BYTES, chunkKeys, stillOwed, supersede, type Op } from '../../src/lib/views/bundles/ops';

describe('D1: session uploads never keep their own type', () => {
	it.each([['synthetic-upload.html', 'text/html'], ['synthetic.svg', 'image/svg+xml'], ['synthetic.pdf', 'application/pdf'], ['x', '']])('%s (%s) -> application/octet-stream', async (name, type) => {
		const f = new File(['<script>document.title = "RAN"</script>'], name, { type });
		const b = uploadBlob(f);
		expect(b.type).toBe('application/octet-stream');
		expect(await b.text()).toBe(await f.text());
	});
});

describe('D7: discovery write ops', () => {
	const op = (id: number, action: Op['action'], value: string, keys: string[]): Op => ({ id, action, value, keys });
	it('chunks 4,000 keys of ~110 characters under the 512 KB body limit, every key once, in order', () => {
		const keys = Array.from({ length: 4000 }, (_, i) => `SYNTHETIC SUPPLEMENTARY FOLDER/Item ${String(i).padStart(4, '0')} ${'x'.repeat(80)}.pdf`);
		const chunks = chunkKeys(keys);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.flat()).toEqual(keys);
		for (const c of chunks) {
			const body = new TextEncoder().encode(c.map((k) => `--b\r\nContent-Disposition: form-data; name="key"\r\n\r\n${k}\r\n--b\r\nContent-Disposition: form-data; name="base"\r\n\r\nC\r\n`).join('')).length;
			expect(body).toBeLessThan(CHUNK_BYTES);
			expect(body).toBeLessThan(512 * 1024);
		}
		expect(chunkKeys([])).toEqual([[]]);
	});
	it('a later op on the same field of the same file takes that file out of a failed op; other fields and files stay', () => {
		const failed = [op(1, 'select', '1', ['a', 'b']), op(2, 'co', 'O', ['a']), op(3, 'mode', 'supplementary', [])];
		expect(supersede(failed, op(4, 'select', '0', ['a']))).toEqual([op(1, 'select', '1', ['b']), op(2, 'co', 'O', ['a']), op(3, 'mode', 'supplementary', [])]);
		expect(supersede(failed, op(5, 'co', 'C', ['a']))).toEqual([op(1, 'select', '1', ['a', 'b']), op(3, 'mode', 'supplementary', [])]);
		expect(supersede(failed, op(6, 'mode', 'discovery', []))).toEqual([op(1, 'select', '1', ['a', 'b']), op(2, 'co', 'O', ['a'])]);
	});
	it('a failed op owes only the files no later queued op sets again (Retry never writes an older value over a newer one)', () => {
		expect(stillOwed(op(1, 'co', 'C', ['a', 'b']), [op(2, 'co', 'O', ['a']), op(3, 'select', '0', ['b'])])).toEqual(op(1, 'co', 'C', ['b']));
		expect(stillOwed(op(1, 'select', '1', ['a']), [op(2, 'select', '0', ['a'])])).toBeNull();
	});
});
