// Cross-Exam Prep rows (GRS-18): imported seeds stay results and are never copied (S-crossexam_tab-1, S-seed-copy);
// user rows follow them; a deleted seed is an overlay; conflict and orphaned overlays stay visible.
import { describe, expect, it } from 'vitest';
import { viewSeeds, type SeedOverlay, type SeedRow } from '../../src/lib/case-package/user-work.ts';
import { canAddCx, crossexamRows, mapV5Crossexam } from '../../src/lib/views/litigation/crossexam.ts';

const seed = (n: number, sha = `sha-${n}`): SeedRow => ({ datasetKey: 'lit-crossexam-seed', seedId: `seed:${n}`, seedSha256: sha, record: { witness: `Witness ${n}`, topic: `Topic ${n}`, put: `Put ${n}`, docs: `Docs ${n}` } });
const overlay = (n: number, fields: Record<string, unknown>, base = `sha-${n}`): SeedOverlay => ({ caseId: 'c', datasetKey: 'lit-crossexam-seed', seedId: `seed:${n}`, baseSeedSha256: base, fields });
const user = (id: string, witness: string, topic = '') => ({ rowId: id, fields: { witness, topic, put: '', docs: '', seq: 1 } });

describe('crossexamRows', () => {
	it('shows seeds in data order, then user rows, with nothing copied', () => {
		const rows = crossexamRows(viewSeeds([seed(1), seed(2)], []), [user('u1', 'W')]);
		expect(rows.map((r) => [r.kind, r.witness])).toEqual([['seed', 'Witness 1'], ['seed', 'Witness 2'], ['user', 'W']]);
		expect(rows[0]!.target).toEqual({ seedId: 'seed:1' });
		expect(rows[2]!.target).toEqual({ rowId: 'u1' });
		expect(rows[0]!.authored).toBe(true);
		expect(rows[2]!.authored).toBe(false);
	});

	it('hides a seed the user deleted (an overlay {deleted: true}) and keeps the others', () => {
		const rows = crossexamRows(viewSeeds([seed(1), seed(2)], [overlay(1, { deleted: true })]), []);
		expect(rows.map((r) => r.witness)).toEqual(['Witness 2']);
	});

	it('shows a later seed version again when it changed after the deletion (conflict)', () => {
		const rows = crossexamRows(viewSeeds([seed(1, 'sha-new')], [overlay(1, { deleted: true }, 'sha-old')]), []);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: 'conflict', witness: 'Witness 1' });
		expect(rows[0]!.note).toMatch(/changed since/);
	});

	it('shows both the current seed and the user edit made against an earlier seed', () => {
		const rows = crossexamRows(viewSeeds([seed(1, 'sha-new')], [overlay(1, { put: 'My put' }, 'sha-old')]), []);
		expect(rows.map((r) => [r.kind, r.put])).toEqual([['seed', 'Put 1'], ['conflict', 'My put']]);
	});

	it('applies an edit over the current seed and keeps an orphaned edit visible', () => {
		const rows = crossexamRows(viewSeeds([seed(1)], [overlay(1, { put: 'Edited' }), overlay(9, { witness: 'Gone', topic: 'T' })]), []);
		expect(rows.map((r) => [r.kind, r.witness, r.put])).toEqual([['edited', 'Witness 1', 'Edited'], ['orphaned', 'Gone', '']]);
		expect(rows[1]!.note).toMatch(/not in this results version/);
	});

	it('drops an orphaned deletion (nothing left to show)', () => {
		expect(crossexamRows(viewSeeds([], [overlay(3, { deleted: true })]), [])).toEqual([]);
	});
});

describe('canAddCx (v5 addCx)', () => {
	it('needs a witness or a topic', () => {
		expect(canAddCx({ witness: '', topic: '', put: 'x', docs: 'y' })).toBe(false);
		expect(canAddCx({ witness: 'W', topic: '', put: '', docs: '' })).toBe(true);
		expect(canAddCx({ witness: '', topic: 'T', put: '', docs: '' })).toBe(true);
	});
});

describe('mapV5Crossexam (a later import of ess_dcs_crossexam_v1)', () => {
	const seeds = [seed(1), seed(2), seed(3)].map((s) => ({ seedId: s.seedId, record: s.record }));
	it('maps equal seeds to nothing, changed seeds to overlays, missing seeds to deletions and the rest to user rows', () => {
		const stored = [
			{ ...seeds[0]!.record },
			{ ...seeds[1]!.record, put: 'Changed' },
			{ witness: 'New', topic: 'Topic', put: 'P', docs: '' },
		];
		const m = mapV5Crossexam(seeds, stored);
		expect(m.overlays).toEqual([{ seedId: 'seed:2', fields: { witness: 'Witness 2', topic: 'Topic 2', put: 'Changed', docs: 'Docs 2' } }, { seedId: 'seed:3', fields: { deleted: true } }]);
		expect(m.userRows).toEqual([{ witness: 'New', topic: 'Topic', put: 'P', docs: '' }]);
	});
	it('treats a second stored row with a seed key as a user row', () => {
		const m = mapV5Crossexam(seeds.slice(0, 1), [{ ...seeds[0]!.record }, { ...seeds[0]!.record }]);
		expect(m.overlays).toEqual([]);
		expect(m.userRows).toHaveLength(1);
	});
});
