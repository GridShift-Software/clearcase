// The CC-07 register entries cover only the differences that really differ (GRS-17, CC-07 r2): the register's own
// matcher is asked whether each counter-case is covered. D8: a missing ref rendered as a link (row 1) is not covered
// by IDR-280/IDR-281. D9: the calendar's escaped text is pinned to the sweep's own synthetic title and note, so an
// unescaped backslash or the wrong text is not covered by IDR-276/IDR-277. Synthetic sweep text only.
import { describe, expect, it } from 'vitest';
import { covering } from '../../scripts/parity/lib/compare.mjs';
import { loadRegister } from '../../scripts/parity/lib/register.mjs';

const { entries, problems } = loadRegister();
const BS = '\\';
const cover = (view: string, path: string, v5: string, app: string) => (covering(entries, view, { path, kind: 'value', v5, app }) as { id: string } | null)?.id ?? null;
const SUMMARY = 'sweep.deadline_order.ics_added.row.0.SUMMARY', DESCRIPTION = 'sweep.deadline_order.ics_added.row.0.DESCRIPTION';
const v5Title = `Synthetic later with comma semicolon ${BS} backslashbreak`;

describe('the CC-07 register entries', () => {
	it('load without problems', () => expect(problems).toEqual([]));

	it('cover the ref that names a document (row 0) and not the missing ref rendered as a link (row 1) (D8)', () => {
		for (const [view, id] of [['privilege_tab', 'IDR-280'], ['annotations_tab', 'IDR-281']] as const) {
			expect(cover(view, 'sweep.doc_ref_link.0.ref', 'text', 'link')).toBe(id);
			expect(cover(view, 'sweep.doc_ref_link.1.ref', 'text', 'link')).toBeNull();
		}
	});

	it("cover the calendar's correctly escaped synthetic title and note only (D9)", () => {
		expect(cover('deadlines_tab', SUMMARY, v5Title, `Synthetic later${BS}, with comma${BS}; semicolon ${BS}${BS} backslashbreak`)).toBe('IDR-276');
		expect(cover('deadlines_tab', SUMMARY, `Synthetic later  with comma  semicolon ${BS} backslashbreak`, `Synthetic later${BS}, with comma${BS}; semicolon ${BS}${BS} backslashbreak`)).toBe('IDR-276');
		expect(cover('deadlines_tab', DESCRIPTION, 'Hearing note one two', `Hearing note${BS}, one${BS}; two`)).toBe('IDR-277');
		// an unescaped backslash, the wrong text, the wrong row
		expect(cover('deadlines_tab', SUMMARY, v5Title, `Synthetic later${BS}, with comma${BS}; semicolon ${BS} backslashbreak`)).toBeNull();
		expect(cover('deadlines_tab', SUMMARY, v5Title, `Totally wrong${BS}, title`)).toBeNull();
		expect(cover('deadlines_tab', DESCRIPTION, 'Hearing note one two', `Filing x${BS};`)).toBeNull();
		expect(cover('deadlines_tab', 'sweep.deadline_order.ics_added.row.1.SUMMARY', v5Title, `Synthetic later${BS}, with comma${BS}; semicolon ${BS}${BS} backslashbreak`)).toBeNull();
		expect(cover('deadlines_tab', SUMMARY, 'Synthetic earlier', `Synthetic earlier${BS},`)).toBeNull();
	});
});
