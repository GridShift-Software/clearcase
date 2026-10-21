import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { checkTarget, loadTargets } from '../../../deploy/probes/target.ts';

const CLIENTS = path.join(import.meta.dirname, '../../../deploy/probes/clients');
const targets = loadTargets(CLIENTS);
const a = targets.find((t) => t.client === 'client-a')!;
const b = targets.find((t) => t.client === 'client-b')!;
const config = (client: string, file: string) => readFileSync(path.join(CLIENTS, client, file), 'utf8');
const FORMATS = [['wrangler', 'wrangler.jsonc'], ['cf', 'cloudflare.config.ts']] as const;

describe('same-account wrong-client identifiers', () => {
	for (const [format, file] of FORMATS) {
		test(`${format}: client B's D1 id in client A's config is refused, naming client B`, () => {
			const swapped = config('client-a', file).replace(a.d1.id, b.d1.id);
			expect(swapped).not.toBe(config('client-a', file));
			expect(a.accountId).toBe(b.accountId);
			const problems = checkTarget({ client: 'client-a', targets, format, text: swapped });
			expect(problems.some((p) => p.includes(b.d1.id) && p.includes('client-b'))).toBe(true);
		});

		test(`${format}: client B's R2 bucket in client A's config is refused, naming client B`, () => {
			const swapped = config('client-a', file).replaceAll(`"${a.r2.bucket}"`, `"${b.r2.bucket}"`);
			const problems = checkTarget({ client: 'client-a', targets, format, text: swapped });
			expect(problems.some((p) => p.includes(b.r2.bucket) && p.includes('client-b'))).toBe(true);
		});

		test(`${format}: client B's Worker name in client A's config is refused, naming client B`, () => {
			const swapped = config('client-a', file).replace(`"name": "${a.worker}"`, `"name": "${b.worker}"`);
			expect(swapped).not.toBe(config('client-a', file));
			const problems = checkTarget({ client: 'client-a', targets, format, text: swapped });
			expect(problems.some((p) => p.includes(b.worker) && p.includes('client-b'))).toBe(true);
		});

		test(`${format}: each client's reviewed config passes its own target check`, () => {
			expect(checkTarget({ client: 'client-a', targets, format, text: config('client-a', file) })).toEqual([]);
			expect(checkTarget({ client: 'client-b', targets, format, text: config('client-b', file) })).toEqual([]);
		});
	}
});
