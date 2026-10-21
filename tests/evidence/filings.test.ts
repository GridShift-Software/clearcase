// Filings register model (GRS-14): imported seeds and user rows stay apart (S-seed-copy), seed deletions and edits are
// overlays with their GRS-10 states, user rows keep insertion order by seq under a fixed clock, and the register CSV
// neutralises user-entered cells only. Synthetic values throughout.
import { describe, expect, it } from 'vitest';
import { toCSV } from '../../src/lib/components/csv.ts';
import { viewSeeds, type SeedOverlay, type SeedRow } from '../../src/lib/case-package/user-work.ts';
import { entryNote, filingsCsvRows, formFields, nextSeq, registerCsvRows, registerEntries } from '../../src/lib/views/evidence/filings.ts';

const seed = (id: string, sha: string, filing: string, ref = ''): SeedRow => ({ datasetKey: 'filings', seedId: id, seedSha256: sha, record: { filing, fdate: '', fparty: 'Synthetic party', response: '', rdate: '', ref, status: 'Synthetic status' } });
const overlay = (id: string, base: string, fields: Record<string, unknown>): SeedOverlay => ({ caseId: 'c1', datasetKey: 'filings', seedId: id, baseSeedSha256: base, fields });
const user = (rowId: string, seq: number, filing: string) => ({ rowId, fields: { seq, filing, fdate: '', fparty: '', response: '', rdate: '', ref: '', status: '' } });

describe('filings register', () => {
	it('shows the seeds in seed order, then user rows in seq order, whatever their row ids', () => {
		const seeds = viewSeeds([seed('seed:a', 'h1', 'Seed A'), seed('seed:b', 'h2', 'Seed B')], []);
		// fixed clock: equal createdAt, so listRows order is by random id; seq decides
		const e = registerEntries(seeds, [user('zzz', 2, 'Second added'), user('aaa', 3, 'Third added'), user('mmm', 1, 'First added')]);
		expect(e.map((x) => x.fields.filing)).toEqual(['Seed A', 'Seed B', 'First added', 'Second added', 'Third added']);
		expect(e.map((x) => x.state)).toEqual(['seed', 'seed', 'user', 'user', 'user']);
		expect(e[0]!.key).toBe('seed:seed:a');
		expect(e[2]!.key).toBe('row:mmm');
	});

	it('hides a seed the user deleted (an overlay), and shows it again with a note when the seed changed since', () => {
		const rows = [seed('seed:a', 'h1', 'Seed A'), seed('seed:b', 'h2', 'Seed B')];
		const del = overlay('seed:a', 'h1', { ...rows[0]!.record, deleted: true });
		expect(registerEntries(viewSeeds(rows, [del]), []).map((x) => x.fields.filing)).toEqual(['Seed B']);
		const changed = [seed('seed:a', 'h9', 'Seed A, corrected'), rows[1]!];
		const e = registerEntries(viewSeeds(changed, [del]), []);
		expect(e[0]).toMatchObject({ state: 'conflict', deletedEarlier: true, userEntered: false });
		expect(e[0]!.fields.filing).toBe('Seed A, corrected');
		expect(entryNote(e[0]!)).toMatch(/deleted this imported row before it changed/);
	});

	it('shows an edited seed with the user values, a conflict with both, and an orphaned edit', () => {
		const rows = [seed('seed:a', 'h1', 'Seed A', 'OD-1')];
		const edit = overlay('seed:a', 'h1', { ...rows[0]!.record, filing: 'Seed A edited', deleted: false });
		expect(registerEntries(viewSeeds(rows, [edit]), [])[0]).toMatchObject({ state: 'edited', userEntered: true, fields: { filing: 'Seed A edited', status: 'Synthetic status' } });
		const conflict = registerEntries(viewSeeds([seed('seed:a', 'h2', 'Seed A new')], [edit]), [])[0]!;
		expect(conflict).toMatchObject({ state: 'conflict', fields: { filing: 'Seed A edited' }, imported: { filing: 'Seed A new' } });
		expect(entryNote(conflict)).toMatch(/^Your edit of an imported row that has changed since\. Imported now: Seed A new/);
		const orphan = registerEntries(viewSeeds([], [edit]), [])[0]!;
		expect(orphan).toMatchObject({ state: 'orphaned', key: 'seed:seed:a', fields: { filing: 'Seed A edited' } });
		expect(registerEntries(viewSeeds([], [overlay('seed:a', 'h1', { deleted: true })]), [])).toEqual([]);
	});

	it('numbers new rows after the largest seq', () => {
		expect(nextSeq([])).toBe(1);
		expect(nextSeq([user('a', 4, 'x'), user('b', 2, 'y')])).toBe(5);
	});

	it('refuses an empty Filing and accepts one of spaces, untrimmed, as v5 does (D17)', () => {
		const f = new Map([['filing', ''], ['ref', 'OD-1']]);
		expect(formFields((k) => f.get(k) ?? null)).toEqual({ ok: false, values: { filing: '', fdate: '', fparty: '', response: '', rdate: '', ref: 'OD-1' } });
		f.set('filing', '   ');
		expect(formFields((k) => f.get(k) ?? null)).toEqual({ ok: true, values: { filing: '   ', fdate: '', fparty: '', response: '', rdate: '', ref: 'OD-1' } });
	});

	it('exports the register in v5 columns, with imported and user-entered formulas neutralised (GRS-172)', () => {
		const rows = [{ ...seed('seed:a', 'h1', '=SUM(A1)'), record: { ...seed('seed:a', 'h1', '=SUM(A1)').record, status: '' } }];
		const e = registerEntries(viewSeeds(rows, []), [user('u', 1, '=HYPERLINK("x")')]);
		const csv = toCSV(registerCsvRows(e));
		expect(csv.split('\r\n')[0]).toBe('filing,fdate,fparty,response,rdate,ref,status');
		expect(csv.split('\r\n')[1]).toBe("'=SUM(A1),,Synthetic party,,,,");
		expect(csv.split('\r\n')[2]!.startsWith("\"'=HYPERLINK(")).toBe(true);
	});

	it('writes untouched imported values of an edited or conflicting seed as imported cells in the export (D16)', () => {
		// ref is an untouched imported `-5`: a plain number stays a number where imported, and is neutralised where typed
		const rec = { filing: '-Imported filing', fdate: '', fparty: '+Imported party', response: '', rdate: '', ref: '-5', status: '' };
		const s = { datasetKey: 'filings', seedId: 'seed:a', seedSha256: 'h1', record: rec };
		const line = (seeds: ReturnType<typeof viewSeeds>) => toCSV(registerCsvRows(registerEntries(seeds, []))).split('\r\n')[1];
		expect(line(viewSeeds([s], []))).toBe("'-Imported filing,,'+Imported party,,,-5,");
		// edited: only the fields the user changed are user-entered (response and fdate, typed as `-5`)
		const edit = overlay('seed:a', 'h1', { ...rec, response: '=my reply', fdate: '-5', deleted: false });
		expect(line(viewSeeds([s], [edit]))).toBe("'-Imported filing,'-5,'+Imported party,'=my reply,,-5,");
		// conflict: compared with the seed as imported now
		expect(line(viewSeeds([{ ...s, seedSha256: 'h2', record: { ...rec, rdate: '2001-02-03' } }], [edit]))).toBe("'-Imported filing,'-5,'+Imported party,'=my reply,,-5,");
		// a user's own row stays fully user-entered
		expect(toCSV(registerCsvRows(registerEntries([], [user('u', 1, '-typed')]))).split('\r\n')[1]).toBe("'-typed,,,,,,");
	});

	it('keeps an untouched imported plain number a number, where the same number typed is neutralised (D16, GRS-172)', () => {
		const rec = { filing: '-5', fdate: '', fparty: '', response: '', rdate: '', ref: '', status: '' };
		const e = registerEntries(viewSeeds([{ datasetKey: 'filings', seedId: 'seed:a', seedSha256: 'h1', record: rec }], []), [user('u', 1, '-5')]);
		expect(toCSV(registerCsvRows(e)).split('\r\n').slice(1)).toEqual(['-5,,,,,,', "'-5,,,,,,"]);
	});

	it('exports every group item in v5 columns and order (L2653)', () => {
		const rows = filingsCsvRows([{ key: 'Group one', note: '', items: [{ ref: 'OD-1', date: '2001-02-03', title: 'T', note: 'N', doc_type: 'other', text_status: 'none', url: './a.pdf' }] }, { key: 'Group two', note: 'x', items: [] }]);
		expect(toCSV(rows)).toBe('group,ref,date,title,note,doc_type,text_status,url\r\nGroup one,OD-1,2001-02-03,T,N,other,none,./a.pdf');
	});
});

/** Synthetic imported values that would become a formula in a reader that splits on `;`, tab, CR or LF (CC-04 r4 M1). */
const HOSTILE = ['x;=1+1', 'x\t=2', 'a\r\n=HYPERLINK("http://a")', 'x\n-1'];
const segmentStarts = (csv: string) => csv.split(/[;\t\r\n]/).map((s) => s.trimStart()[0] ?? '');

describe('the filings export neutralises imported values for a `;`, tab or line-split reader (CC-04 r4 M1)', () => {
	it('starts no field after a separator with a formula character', () => {
		const csv = toCSV(filingsCsvRows([{ key: 'Group one', note: '', items: HOSTILE.map((h, i) => ({ ref: `OD-${i}`, date: '', title: h, note: h, doc_type: 'other', text_status: 'none', url: h })) }]));
		expect(segmentStarts(csv).filter((c) => '=+-@'.includes(c) && c !== '')).toEqual([]);
		expect(csv).toContain("x;'=1+1");
		expect(csv).toContain("x\n'-1");
	});
});
