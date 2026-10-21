// PR #88 round 1: the newer mapping keeps a source field that is already named source_<name>; it never overwrites it.
// Every value below is invented.
import { describe, expect, it } from 'vitest';
import { defenceRowOf, riskMatrixOf, timelineEventOf } from '../../src/lib/case-package/v5/newer-workspace.ts';

type J = Record<string, any>;

describe('a source field already named source_<name> is never overwritten by the mapping (PR #88 round 1)', () => {
  const none = new Map();
  const values = (o: J) => Object.values(o).filter((v) => v === 'held' || v === 5);
  it('keeps both values on a timeline event, a defence row and a risk, whichever key comes first', () => {
    for (const e of [{ source_date: 'held', date: 5, title: 't' }, { date: 5, source_date: 'held', title: 't' }]) expect(values(timelineEventOf(e, none)).sort()).toEqual([5, 'held']);
    for (const r of [{ theirs: 'x', docs: 5, source_docs: 'held' }, { theirs: 'x', source_docs: 'held', docs: 5 }]) expect(values(defenceRowOf(r, none)).sort()).toEqual([5, 'held']);
    for (const r of [{ category: 5, source_category: 'held' }, { source_category: 'held', category: 5 }]) expect(values((riskMatrixOf([r]) as J[])[0]!).sort()).toEqual([5, 'held']);
  });
});
