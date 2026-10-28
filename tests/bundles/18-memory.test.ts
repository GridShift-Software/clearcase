import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
test('60 MiB raw PDF read and digest retain near one body of memory in an isolated process', () => {
	const output = execFileSync(
		'node',
		['--expose-gc', 'scripts/bundles/18-memory-probe.ts'],
		{ encoding: 'utf8' },
	);
	const result = JSON.parse(output);
	console.info('18 allocation probe', result);
	expect(result.bodyBytes).toBe(60 * 1024 * 1024);
	expect(result.peakArrayBuffersDelta).toBeLessThanOrEqual(
		result.bodyBytes * 1.1,
	);
	expect(result.peakRssDelta).toBeLessThanOrEqual(result.bodyBytes * 1.4);
}, 20000);
