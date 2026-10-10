// Register writes are serialized per key (GRS-18): a write that reads the largest seq never interleaves with another
// write of the same register, and a failed write does not block the next one.
import { describe, expect, it } from 'vitest';
import { serialized } from '../../src/lib/views/litigation/serial.ts';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('serialized', () => {
	it('runs calls with one key one after another, in call order', async () => {
		const log: string[] = [];
		let seq = 0;
		const write = (name: string, wait: number) => serialized('case\u0000heads', async () => { const s = seq + 1; log.push(`${name} read ${s}`); await tick(wait); seq = s; log.push(`${name} wrote ${s}`); return s; });
		const got = await Promise.all([write('a', 30), write('b', 1), write('c', 5)]);
		expect(got).toEqual([1, 2, 3]);
		expect(log).toEqual(['a read 1', 'a wrote 1', 'b read 2', 'b wrote 2', 'c read 3', 'c wrote 3']);
	});
	it('does not hold back other keys', async () => {
		const order: string[] = [];
		const slow = serialized('k1', async () => { await tick(30); order.push('k1'); });
		const fast = serialized('k2', async () => { order.push('k2'); });
		await Promise.all([slow, fast]);
		expect(order).toEqual(['k2', 'k1']);
	});
	it('lets the next call run after a failure, and still rejects the failed one', async () => {
		const failed = serialized('k3', async () => { throw new Error('busy'); });
		const next = serialized('k3', async () => 'ok');
		await expect(failed).rejects.toThrow('busy');
		await expect(next).resolves.toBe('ok');
	});
});
