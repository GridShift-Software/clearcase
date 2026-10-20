// ZIP reader: lists every central-directory entry in order (duplicates kept, unsafe paths shown as text and flagged),
// verifies each member by bounded fflate extraction and CRC, and opens supported members through the shell by
// ordinal. Unsupported methods, encryption, symlinks, unsafe paths, CRC errors and expansion limits are explicit.
import { app, boot, el, fail, okRes, publish, send, state, RenderError } from './common.mjs';
import { extractEntry, listZip, sniff } from '../shared/formats.mjs';

boot('archive', { open });

async function open(descriptor, bytes) {
  const s = sniff(bytes);
  if (s.kind !== 'zip') throw new RenderError('not-zip', `content sniffed as ${s.mime}`);
  if (s.variant === 'split') throw new RenderError('split-archive', 'split/multi-volume ZIP is not supported');
  const t0 = performance.now();
  const { error, entries } = listZip(bytes);
  if (error) throw new RenderError(`archive-${error}`, error);
  const trusted = new Map((descriptor.children ?? []).map((c) => [c.key, c]));
  const rows = entries.map((e) => {
    const x = e.directory && !e.problems.length ? { ok: true, bytes: new Uint8Array() } : extractEntry(bytes, e);
    const child = trusted.get(String(e.ordinal));
    return { ordinal: e.ordinal, path: e.path, size: e.size, method: e.method, directory: e.directory, duplicateName: e.duplicateName, status: x.ok ? 'ok' : x.reason, expandedAtStop: x.expandedAtStop ?? null, openable: x.ok && !e.directory && !!child?.assetId, childFamily: child?.family ?? null };
  });
  const A = (state.archive = { entries: rows, listMs: Math.round(performance.now() - t0), problems: rows.filter((r) => r.status !== 'ok').length, selected: null });
  const table = el('table', { class: 'entries' }, el('caption', {}, `${rows.length} entries`), el('thead', {}, el('tr', {}, ...['#', 'Path', 'Size', 'Method', 'Status', ''].map((h) => el('th', { scope: 'col' }, h)))));
  const tbody = el('tbody');
  for (const r of rows) {
    tbody.append(el('tr', { 'data-ordinal': String(r.ordinal) }, el('td', {}, String(r.ordinal + 1)), el('td', {}, r.path, r.duplicateName ? el('span', { class: 'badge' }, 'duplicate name') : null), el('td', {}, r.directory ? 'folder' : String(r.size)), el('td', {}, { 0: 'stored', 8: 'deflate' }[r.method] ?? `method ${r.method}`), el('td', { 'data-status': r.status }, r.status === 'ok' ? 'OK' : `Cannot preview: ${r.status}`), el('td', {}, r.openable ? el('button', { type: 'button', 'data-ordinal': String(r.ordinal), onclick: () => send({ type: 'open-child', key: String(r.ordinal) }) }, `Open ${r.path.split('/').pop()}`) : '')));
  }
  table.append(tbody);
  if (A.problems) app.append(el('p', { class: 'notice', id: 'archive-problems' }, `${A.problems} entr${A.problems === 1 ? 'y' : 'ies'} cannot be previewed. The archive is not ready for publication until each is repaired.`));
  app.append(table);
  publish();
  return {
    async navigate(t) {
      for (const n of tbody.querySelectorAll('tr.target')) n.classList.remove('target');
      if (!t || t.kind === 'file') return okRes('File-level reference: no precise location supplied', { fileLevel: true });
      if (t.kind !== 'archive-entry') return fail('unsupported-target', `target kind ${t.kind} does not apply to an archive`, true);
      let hit;
      if (t.ordinal !== undefined) hit = rows.find((r) => r.ordinal === t.ordinal);
      else { const m = rows.filter((r) => r.path === t.path); if (m.length > 1) return fail('ambiguous-entry', `${m.length} entries are named ${JSON.stringify(t.path)}; cite one by position`, true); hit = m[0]; }
      if (!hit) return fail('invalid-target', `no entry ${JSON.stringify(t.ordinal ?? t.path)}`, true);
      const tr = tbody.querySelector(`tr[data-ordinal="${hit.ordinal}"]`);
      tr.classList.add('target');
      tr.scrollIntoView({ block: 'center' });
      (tr.querySelector('button') ?? tr).focus?.();
      A.selected = hit.ordinal;
      publish();
      return okRes(`Entry ${hit.ordinal + 1}: ${hit.path}`);
    },
  };
}
