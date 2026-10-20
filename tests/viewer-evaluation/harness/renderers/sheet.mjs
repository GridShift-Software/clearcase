// Read-only workbook reader: SheetJS CE 0.20.3 parses (formulas, number formats, hidden flags, comments kept),
// Tabulator 6.6.1 draws one virtual grid per sheet. Every sheet gets a tab, hidden ones labelled; hidden rows and
// columns stay visible and labelled; a formula without a stored result shows the formula and "value unavailable".
// Cells are written as text nodes, never HTML. Search runs over the parsed model, not the rendered viewport.
import * as XLSX from 'xlsx';
import { TabulatorFull as Tabulator } from 'tabulator-tables';
import { app, boot, el, fail, okRes, publish, state, RenderError } from './common.mjs';
import { parseA1, sniff } from '../shared/formats.mjs';

boot('sheet', { open });

const HIDDEN = ['', 'hidden', 'very hidden'];

function model(wb) {
  return wb.SheetNames.map((name, i) => {
    const ws = wb.Sheets[name];
    const hidden = wb.Workbook?.Sheets?.[i]?.Hidden ?? 0;
    const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    const hiddenRows = (ws['!rows'] ?? []).map((r, k) => (r?.hidden ? k : -1)).filter((k) => k >= 0);
    const hiddenCols = (ws['!cols'] ?? []).map((c, k) => (c?.hidden ? k : -1)).filter((k) => k >= 0);
    return { name, hidden, ws, range, hiddenRows, hiddenCols, merges: (ws['!merges'] ?? []).map((m) => XLSX.utils.encode_range(m)) };
  });
}

function info(ws, r, c) {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = ws[addr];
  if (!cell) return { addr, empty: true, display: '' };
  // SheetJS CE 0.20.3 reads a formula with no stored <v> as a stub { t: 'z', v: 0 }: key on the type, never show the 0
  const unavailable = cell.f !== undefined && (cell.v === undefined || cell.t === 'z');
  const display = unavailable ? `=${cell.f}` : cell.w ?? (cell.v === undefined ? '' : String(cell.v));
  return { addr, type: cell.t, stored: unavailable || cell.v === undefined ? null : cell.v, display, formula: cell.f ?? null, format: cell.z ?? null, unavailable, comments: (cell.c ?? []).map((x) => ({ author: x.a, text: x.t })) };
}

async function open(descriptor, bytes, extras, target) {
  const s = sniff(bytes);
  const isCsv = /\.csv$/i.test(descriptor.name);
  let wb;
  const t0 = performance.now();
  try {
    wb = isCsv ? XLSX.read(new TextDecoder().decode(bytes), { type: 'string', raw: true, cellText: true, dense: false })
      : XLSX.read(bytes, { type: 'array', cellFormula: true, cellNF: true, cellStyles: true, cellText: true, cellDates: false });
  } catch (e) { throw new RenderError('workbook-unreadable', `${s.mime}: ${e?.message ?? e}`); }
  const parseMs = Math.round(performance.now() - t0);
  const sheets = model(wb);
  const S = (state.sheet = { parseMs, date1904: !!wb.Workbook?.WBProps?.date1904, sheets: sheets.map(({ ws, ...m }) => ({ ...m, range: XLSX.utils.encode_range(m.range) })), active: null, selected: null, search: null, gridMs: null });
  const tabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Sheets' });
  const find = el('input', { type: 'search', id: 'find', 'aria-label': 'Search all sheets', placeholder: 'Search all sheets' });
  const findStatus = el('span', { id: 'find-status', 'aria-live': 'polite' });
  const gridHost = el('div', { id: 'grid', tabindex: '0', role: 'region', 'aria-label': 'Sheet grid. Arrow keys move the selected cell.' });
  const details = el('div', { class: 'cell-details', id: 'cell-details', 'aria-live': 'polite' });
  const notices = (descriptor.renditions ?? []).filter((r) => r.role === 'supplement').map((r) => el('p', { class: 'notice', 'data-supplement': r.assetId }, `This workbook has visual content the grid cannot show (charts or drawings). A prepared supplement, version ${r.version}, shows it.`));
  app.append(el('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Workbook controls' }, find, findStatus, el('span', { class: 'badge' }, `Date system ${S.date1904 ? '1904' : '1900'}`)), ...notices, tabs, gridHost, details);
  gridHost.style.height = `${Math.max(240, innerHeight - 220)}px`;
  let table = null;
  let active = -1;
  let marked = null;
  const tabEls = sheets.map((sh, i) => {
    const b = el('button', { role: 'tab', type: 'button', id: `tab-${i}`, 'aria-selected': 'false', tabindex: '-1', 'data-sheet': sh.name, onclick: () => activate(i) }, sh.name, sh.hidden ? el('span', { class: 'hidden-label' }, HIDDEN[sh.hidden]) : null);
    tabs.append(b);
    return b;
  });
  tabs.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (d) { e.preventDefault(); const n = (active + d + sheets.length) % sheets.length; activate(n).then(() => tabEls[n].focus()); }
    if (e.key === 'Home') { e.preventDefault(); activate(0).then(() => tabEls[0].focus()); }
    if (e.key === 'End') { e.preventDefault(); activate(sheets.length - 1).then(() => tabEls[sheets.length - 1].focus()); }
  });

  function select(r, c, range) {
    const sh = sheets[active];
    for (const n of gridHost.querySelectorAll('.cell-target')) n.classList.remove('cell-target');
    const rr = range ?? { s: { r, c }, e: { r, c } };
    marked = rr;
    // Tabulator re-renders rows while scrolling, so the highlight is applied by the cell formatter and re-applied here.
    const mark = () => { for (let y = rr.s.r; y <= rr.e.r; y++) for (let x = rr.s.c; x <= rr.e.c; x++) { try { table.getRow(y + 1)?.getCell(`c${x}`)?.getElement().classList.add('cell-target'); } catch {} } };
    Promise.allSettled([table.scrollToRow(r + 1, 'center', false), table.scrollToColumn(`c${c}`, 'center', false)]).then(mark);
    mark();
    const inf = info(sh.ws, r, c);
    const hiddenRow = sh.hiddenRows.includes(r), hiddenCol = sh.hiddenCols.includes(c);
    S.selected = { sheet: sh.name, ...inf, addr: range ? XLSX.utils.encode_range(range) : inf.addr, hiddenRow, hiddenCol };
    details.textContent = [`${sh.name}!${S.selected.addr}${hiddenRow ? ' (hidden row)' : ''}${hiddenCol ? ' (hidden column)' : ''}`, inf.empty ? 'empty cell' : `type ${inf.type}; displayed "${inf.display}"; stored ${inf.unavailable ? 'value unavailable (no stored result)' : JSON.stringify(inf.stored)}${inf.formula ? `; formula =${inf.formula}` : ''}${inf.format ? `; format ${inf.format}` : ''}`, ...inf.comments?.map((x) => `comment (${x.author}): ${x.text}`) ?? []].join('\n');
    publish();
  }

  async function activate(i) {
    if (i === active) return;
    active = i;
    marked = null;
    tabEls.forEach((t, k) => { t.setAttribute('aria-selected', String(k === i)); t.tabIndex = k === i ? 0 : -1; });
    const sh = sheets[i];
    const { s: st, e: en } = sh.range;
    const cols = [{ title: '', field: '_r', frozen: true, headerSort: false, width: 64, formatter: (cell) => { const r = cell.getValue(); return el('span', {}, String(r), sh.hiddenRows.includes(r - 1) ? el('span', { class: 'badge' }, 'hidden') : null); } }];
    for (let c = 0; c <= en.c; c++) {
      const hiddenCol = sh.hiddenCols.includes(c);
      cols.push({ title: XLSX.utils.encode_col(c) + (hiddenCol ? ' (hidden)' : ''), field: `c${c}`, headerSort: false, cssClass: hiddenCol ? 'hidden-rowcol' : '', formatter: (cell) => {
        const v = cell.getValue();
        const r = cell.getRow().getData()._r - 1;
        cell.getElement().classList.toggle('cell-target', !!marked && r >= marked.s.r && r <= marked.e.r && c >= marked.s.c && c <= marked.e.c);
        if (!v) return '';
        return el('span', { class: v.unavailable ? 'value-unavailable' : '' }, v.display, v.unavailable ? el('span', { class: 'badge' }, 'value unavailable') : null, v.comment ? el('span', { class: 'badge', title: 'Has comment' }, 'comment') : null);
      } });
    }
    const rows = [];
    for (let r = 0; r <= en.r; r++) {
      const row = { _r: r + 1 };
      for (let c = st.c; c <= en.c; c++) { const inf = info(sh.ws, r, c); if (!inf.empty) row[`c${c}`] = { display: inf.display, unavailable: inf.unavailable, comment: inf.comments.length > 0 }; }
      rows.push(row);
    }
    table?.destroy();
    const g0 = performance.now();
    table = new Tabulator(gridHost, { data: rows, columns: cols, index: '_r', height: gridHost.style.height, layout: 'fitData', renderVertical: 'virtual', renderHorizontal: en.c > 30 ? 'virtual' : 'basic', headerSort: false, movableColumns: false, clipboard: false, selectableRows: false, rowFormatter: (row) => { if (sh.hiddenRows.includes(row.getData()._r - 1)) { row.getElement().classList.add('hidden-rowcol'); row.getElement().setAttribute('aria-label', `Row ${row.getData()._r} (hidden in the workbook)`); } } });
    table.on('cellClick', (_e, cell) => { const f = cell.getField(); if (f.startsWith('c')) select(cell.getRow().getData()._r - 1, Number(f.slice(1))); });
    await new Promise((res) => table.on('tableBuilt', res));
    S.gridMs = Math.round(performance.now() - g0);
    S.active = sh.name;
    S.selected = null;
    publish();
  }

  gridHost.addEventListener('keydown', (e) => {
    const d = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] }[e.key];
    if (!d) return;
    e.preventDefault();
    const sh = sheets[active];
    const cur = S.selected ? XLSX.utils.decode_cell(S.selected.addr.split(':')[0]) : { r: 0, c: 0 };
    const r = Math.min(sh.range.e.r, Math.max(0, cur.r + (S.selected ? d[0] : 0)));
    const c = Math.min(sh.range.e.c, Math.max(0, cur.c + (S.selected ? d[1] : 0)));
    select(r, c);
  });

  find.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const q = find.value.trim().toLowerCase();
    if (!q) return;
    if (S.search?.query !== q) {
      const hits = [];
      sheets.forEach((sh) => { for (const [addr, cell] of Object.entries(sh.ws)) { if (addr[0] === '!') continue; const hay = [cell.w, cell.v, cell.f].filter((x) => x !== undefined).join(' ').toLowerCase(); if (hay.includes(q)) hits.push(`${sh.name}!${addr}`); } });
      S.search = { query: q, hits, index: -1 };
    }
    if (!S.search.hits.length) { findStatus.textContent = 'No matches'; publish(); return; }
    S.search.index = (S.search.index + 1) % S.search.hits.length;
    const [sheet, addr] = S.search.hits[S.search.index].split('!');
    await go(sheet, addr);
    findStatus.textContent = `Match ${S.search.index + 1} of ${S.search.hits.length}: ${S.search.hits[S.search.index]}`;
    publish();
  });

  async function go(sheet, ref) {
    const i = sheets.findIndex((x) => x.name === sheet);
    const rg = parseA1(ref);
    await activate(i);
    select(rg.s.r, rg.s.c, rg.s.r === rg.e.r && rg.s.c === rg.e.c ? null : rg);
  }

  window.__sheet = {
    cell: (sheet, addr) => { const sh = sheets.find((x) => x.name === sheet); const { r, c } = XLSX.utils.decode_cell(addr); return info(sh.ws, r, c); },
    domText: (addr) => { const { r, c } = XLSX.utils.decode_cell(addr); try { return table.getRow(r + 1)?.getCell(`c${c}`)?.getElement().textContent ?? null; } catch { return null; } },
    domHtmlHasImg: () => !!gridHost.querySelector('.tabulator-cell img'),
    raw: (sheet, addr) => { const c = sheets.find((x) => x.name === sheet)?.ws[addr]; return c ? { t: c.t, v: c.v ?? null, f: c.f ?? null } : null; },
  };
  await activate(0);
  return {
    async navigate(t) {
      if (!t || t.kind === 'file') return okRes('File-level reference: no precise location supplied', { fileLevel: true });
      if (t.kind !== 'cell') return fail('unsupported-target', `target kind ${t.kind} does not apply to a workbook`, true);
      const i = sheets.findIndex((x) => x.name === t.sheet);
      if (i < 0) return fail('invalid-target', `no sheet named ${JSON.stringify(t.sheet)} (names are exact)`, true);
      const rg = parseA1(t.ref);
      if (!rg) return fail('invalid-target', `${JSON.stringify(t.ref)} is not a cell or range inside the Excel grid`, true);
      await go(t.sheet, t.ref);
      const sh = sheets[i];
      const outside = rg.e.r > sh.range.e.r || rg.e.c > sh.range.e.c;
      return okRes(`${t.sheet}!${t.ref.toUpperCase()}${sh.hidden ? ` (sheet is ${HIDDEN[sh.hidden]})` : ''}${outside ? ' (outside the used range: empty)' : ''}`);
    },
  };
}
