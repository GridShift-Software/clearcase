// H2 (REVIEW.md: fail-open): mutate every field of representative descriptors (delete, null, retype) and require that
// the shell refuses each one before a frame exists, and that each reader refuses it again on its own when the shell's
// check is skipped (opts.unvalidated, a test-only switch). Nothing may render, and no citation may resolve, from a
// descriptor that is not exactly the schema.
const F = 'descriptor';
const C = 'descriptor validator (shell and every reader)';

/** Fields that the schema allows to be null whatever the role; any other null is a mutation that must be refused. */
const NULLABLE = [/^variant$/, /^pages$/, /^rendition\.page$/, /^renditions\[\]\.page$/, /^children\[\]\.(name|declaredMime|contentId)$/];
const RETYPE = { string: 42, number: 'x', boolean: 'true', array: {}, object: [], null: 'x' };
const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

const BASES = [
  ['pdf/text-basic.pdf', 'PDF original'],
  ['word/full-content.rendition-v1.pdf', 'prepared PDF rendition (role, original, rendition)'],
  ['word/full-content.docx', 'original with linked renditions'],
  ['image/png-pattern.png', 'image original'],
  ['sheet/main.xlsx', 'workbook original'],
  ['media/mp4-h264-aac-faststart.mp4', 'media original'],
  ['email/gmail-download.eml', 'email with attachment children'],
  ['email/gmail-download.eml#1', 'child (parent)'],
  ['email/hostile.eml', 'email with holds'],
  ['archive/basic.zip', 'archive with member children'],
  ['archive/basic.zip#1', 'text member'],
];

/** Every mutation of `d`: [{ path, how, value }] (value undefined means delete). Arrays are entered at elements 0 and 1. */
function* mutations(v, path = []) {
  if (v !== null && typeof v === 'object') {
    const keys = Array.isArray(v) ? [0, 1].filter((i) => i < v.length) : Object.keys(v);
    for (const k of keys) {
      const p = [...path, k];
      const norm = p.map((x) => (typeof x === 'number' ? '[]' : `.${x}`)).join('').replace(/^\./, '').replace(/\.\[\]/g, '[]');
      const val = v[k];
      if (!Array.isArray(v)) yield { path: p, norm, how: 'delete', value: undefined };
      if (val !== null && !NULLABLE.some((r) => r.test(norm))) yield { path: p, norm, how: 'null', value: null };
      if (kindOf(val) in RETYPE) yield { path: p, norm, how: 'retype', value: RETYPE[kindOf(val)] };
      yield* mutations(val, p);
    }
  }
}

function apply(d, m) {
  const out = structuredClone(d);
  let o = out;
  for (const k of m.path.slice(0, -1)) o = o[k];
  const last = m.path.at(-1);
  if (m.value === undefined) delete o[last]; else o[last] = m.value;
  return out;
}

let serial = 0;
function serve(c, base, d) {
  const id = `${base}@mutant-${serial++}`;
  c.store.assets.set(id, c.store.assets.get(base));
  c.descriptors.set(id, d);
  return id;
}
const unserve = (c, id) => { c.store.assets.delete(id); c.descriptors.delete(id); };

export default async function descriptor(c, { full }) {
  if (!full) return;
  const escapes = { shell: 0, reader: 0 };
  for (const [base, label] of BASES) {
    const d = c.descriptors.get(base);
    if (!d) { c.record(F, base, C, 'base descriptor exists', false, 'present', null); continue; }
    const all = [...mutations(d)].filter((m) => JSON.stringify(apply(d, m)) !== JSON.stringify(d));
    const shellEscapes = [], readerEscapes = [];
    for (const m of all) {
      const id = serve(c, base, apply(d, m));
      const tag = `${m.norm} ${m.how}`;
      const rs = await c.open(id);
      if (!(rs.ok === false && /^descriptor:/.test(rs.error ?? ''))) shellEscapes.push({ tag, got: rs.type ?? rs.error });
      const rr = await c.open(id, { kind: 'file' }, { unvalidated: true, timeoutMs: 8000 });
      if (!(rr.type === 'error' && rr.code === 'invalid-descriptor')) readerEscapes.push({ tag, got: rr.code ?? rr.type });
      unserve(c, id);
    }
    c.record(F, base, C, `shell refuses every deleted, null or retyped field of the ${label} descriptor`, shellEscapes.length === 0, `${all.length} mutations, all refused with 'descriptor:' before a frame exists`, { mutations: all.length, escapes: shellEscapes.slice(0, 12), escapeCount: shellEscapes.length });
    c.record(F, base, C, `the reader refuses the same mutations by itself when the shell check is skipped (${label})`, readerEscapes.length === 0, `${all.length} mutations, all answered by the reader with error 'invalid-descriptor'`, { mutations: all.length, escapes: readerEscapes.slice(0, 12), escapeCount: readerEscapes.length });
    escapes.shell += shellEscapes.length; escapes.reader += readerEscapes.length;
  }

  // The finding as reported: `role` removed from an unmapped rendition made `original-page 2` resolve as ok.
  const base = 'word/full-content.rendition-v1.pdf';
  const d = c.descriptors.get(base);
  await c.open(base, { kind: 'file' });
  const plain = await c.navigate({ kind: 'original-page', page: 2 });
  c.record(F, base, C, 'unmutated: original page 2 on a rendition with no verified mapping returns unmapped-original-location', plain.resolution?.ok === false && plain.resolution?.code === 'unmapped-original-location', "resolution.code === 'unmapped-original-location'", plain.resolution);
  const outcomes = [];
  for (const role of [undefined, null, 'Rendition', 'x', '', 42, ['rendition']]) {
    const id = serve(c, base, apply(d, { path: ['role'], value: role }));
    const r = await c.open(id, { kind: 'original-page', page: 2 }, { unvalidated: true, timeoutMs: 8000 });
    const nav = r.type === 'ready' ? await c.navigate({ kind: 'original-page', page: 2 }) : null;
    outcomes.push({ role: role === undefined ? 'deleted' : role, type: r.type, code: r.code ?? null, resolved: nav?.resolution?.ok ?? null });
    unserve(c, id);
  }
  c.record(F, base, C, 'a rendition whose role is deleted, null or retyped never resolves an original page', outcomes.every((o) => o.type === 'error' && o.code === 'invalid-descriptor' && o.resolved === null), 'the reader refuses to open it; original-page 2 never resolves ok', outcomes);
}
