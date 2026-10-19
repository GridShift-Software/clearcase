import { accepts, keyboardRoundTrip, layout, opens, rejects, sleep } from './common.mjs';

const F = 'archive';
const C = 'fflate 0.8.3 + entry list';
const ar = async (c) => (await c.rstate()).archive;

export default async function archive(c, { full, skipLarge }) {
  let id = 'archive/basic.zip';
  await opens(c, F, id, C);
  await layout(c, F, id, C);
  if (!full) { await accepts(c, F, id, C, { kind: 'archive-entry', ordinal: 5 }, 'statement.pdf'); return; }
  let st = await ar(c);
  c.record(F, id, C, 'every entry listed in order with status (directory, empty, Unicode, stored, deflated)', st.entries.length === 9 && st.problems === 0 && st.entries[4].path === 'Ünïcode – 名前.txt' && st.entries[0].directory, '9 entries, 0 problems, Unicode name intact, directory first', st.entries.map((e) => [e.ordinal, e.path, e.status]));
  for (const [ord, fam] of [[5, 'pdf'], [6, 'email'], [7, 'sheet'], [8, 'archive'], [1, 'text']]) {
    await c.open(id);
    // click after the evaluate returns: the shell replaces this frame with the child's reader
    const btn = await c.inFrame((o) => { const b = document.querySelector(`button[data-ordinal="${o}"]`); if (b) setTimeout(() => b.click(), 0); return !!b; }, ord);
    await sleep(900);
    const cur = await c.page.evaluate(() => window.__shell.current());
    const rs = await c.rstate();
    c.record(F, id, C, `member ${ord} opens in the ${fam} reader (recursive dispatch)`, btn && cur?.family === fam && rs?.ready === true, `shell opened the child as ${fam} and it reported ready`, { family: cur?.family, ready: rs?.ready, error: rs?.error });
  }
  await c.open(id);
  await accepts(c, F, id, C, { kind: 'archive-entry', path: 'statement.pdf' }, 'statement.pdf', async () => (await ar(c)).selected === 5);
  await rejects(c, F, id, C, [[{ kind: 'archive-entry', ordinal: 42 }, 'invalid-target'], [{ kind: 'archive-entry', path: 'nope.txt' }, 'invalid-target']], async () => (await ar(c)).selected);
  await keyboardRoundTrip(c, F, id, C);

  id = 'archive/duplicates.zip';
  await opens(c, F, id, C);
  st = await ar(c);
  c.record(F, id, C, 'duplicate names kept as separate entries', st.entries.length === 2 && st.entries.every((e) => e.duplicateName && e.status === 'ok'), '2 rows, both flagged duplicate', st.entries);
  await rejects(c, F, id, C, [[{ kind: 'archive-entry', path: 'report.txt' }, 'ambiguous-entry']], async () => (await ar(c)).selected);
  await accepts(c, F, id, C, { kind: 'archive-entry', ordinal: 1 }, 'Entry 2');

  for (const [fid, want] of [['archive/traversal.zip', { '../../evil.txt': 'unsafe-path', '/abs/evil.txt': 'unsafe-path', 'C:\\evil.txt': 'unsafe-path', 'link-to-etc': 'symlink', 'safe.txt': 'ok' }], ['archive/corrupt-crc.zip', { 'bad.txt': 'crc-mismatch' }], ['archive/encrypted-flag.zip', { 'secret.txt': 'encrypted' }], ['archive/unsupported-method.zip', { 'lzma.txt': 'unsupported-method-14' }], ['archive/bomb-256mib.zip', { 'zeros.bin': 'declared-size-over-limit' }], ['archive/bomb-lying-size.zip', { 'zeros.bin': 'expansion-limit-exceeded' }], ['archive/stored-lying-size.zip', { 'zeros.bin': 'expansion-limit-exceeded' }]]) {
    const t0 = Date.now();
    await opens(c, F, fid, C);
    st = await ar(c);
    const got = Object.fromEntries(st.entries.map((e) => [e.path, e.status]));
    const notice = await c.inFrame(() => !!document.getElementById('archive-problems'));
    c.record(F, fid, C, 'unsafe or unreadable members listed with an explicit reason, never extracted', JSON.stringify(got) === JSON.stringify(want) && notice, `statuses ${JSON.stringify(want)}; not-ready notice shown`, { got, ms: Date.now() - t0, expandedAtStop: st.entries.map((e) => e.expandedAtStop).filter(Boolean) });
    c.record(F, fid, 'candidate import', 'the archive holds the update', c.descriptors.get(fid).holds.length > 0, 'descriptor.holds non-empty', c.descriptors.get(fid).holds.map((h) => h.code));
  }

  if (!skipLarge) {
    id = 'archive/many-1000.zip';
    const r = await opens(c, F, id, C);
    st = await ar(c);
    const last = await c.navigate({ kind: 'archive-entry', ordinal: 999 });
    c.record(F, id, C, '1,000 members listed, verified and addressable', st.entries.length === 1000 && st.problems === 0 && last.resolution?.ok, '1000 rows, 0 problems, ordinal 999 reachable', { readyMs: r.ms, listMs: st.listMs });
  }
}
