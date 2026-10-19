// What the CI workflow (.github/workflows/ci.yml) must keep true, read from the file: GitHub only runs it on a push, so
// a mistake here would show up as a red job after the fact.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const text = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const doc = (Bun as unknown as { YAML: { parse(s: string): { jobs: Record<string, { steps: Record<string, unknown>[] }> } } }).YAML.parse(text);
const steps = doc.jobs.check!.steps;
const runs = steps.map((s) => (typeof s.run === 'string' ? s.run : '')).filter(Boolean);

describe('CI workflow receipts', () => {
	// actions/upload-artifact refuses these in a path, and a receipt's folder is named after its --name.
	const REFUSED = /["\\:<>|*?\r\n]/;
	const names = runs.flatMap((r) => [...r.matchAll(/--name\s+(\S+)/g)].map((m) => m[1]!));

	it('names the three receipts', () => {
		expect(names).toEqual(['check', 'test', 'gate-hosted']);
	});
	it.each(names)('receipt name %s has no character that artifact upload refuses', (n) => {
		expect(n).not.toMatch(REFUSED);
	});
	it('asks the summary for exactly the receipts the job writes', () => {
		const summary = runs.find((r) => r.includes('scripts/ci/summary.ts'))!;
		expect(summary.trim().split(/\s+/).slice(2).filter((w) => !w.startsWith('"'))).toEqual(names);
	});
});
