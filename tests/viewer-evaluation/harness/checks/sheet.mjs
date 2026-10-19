import { accepts, keyboardRoundTrip, layout, opens, rejects, sleep } from './common.mjs';
import { importAll } from '../import.mjs';

/** Import one fixture as if it were the whole candidate (no renditions or supplements alongside it). */
async function importOnly(store, id) {
  const a = store.assets.get(id);
  const solo = { manifest: store.manifest, assets: new Map([[id, { ...a, children: undefined }]]), add: store.add };
  return (await importAll(solo)).get(id);
}

const F = 'sheet';
const C = 'SheetJS CE 0.20.3 + Tabulator 6.6.1';
const sel = (c) => () => c.inFrame(() => window.__r.sheet.selected?.addr ?? null);

async function workbookChecks(c, id, comp, { xls = false } = {}) {
  const st = (await c.rstate()).sheet;
  const sheets = st.sheets.map((s) => [s.name, s.hidden]);
  c.record(F, id, comp, 'every sheet has a tab, hidden and very hidden labelled', JSON.stringify(sheets) === JSON.stringify([['Summary', 0], ['HiddenSheet', 1], ['VeryHidden', xls ? 1 : 2], ['Notes Ü', 0]]) && (await c.inFrame(() => document.querySelectorAll('.tabs .hidden-label').length)) === 2, `tabs Summary, HiddenSheet(hidden), VeryHidden(${xls ? 'hidden: the LibreOffice-written .xls lost very-hidden' : 'very hidden'}), Notes Ü`, sheets);
  const sum = st.sheets[0];
  c.record(F, id, comp, 'hidden row 6 and column D kept and labelled', sum.hiddenRows.includes(5) && sum.hiddenCols.includes(3) && (await c.inFrame(() => document.querySelectorAll('.hidden-rowcol').length)) > 0, 'hiddenRows includes 5, hiddenCols includes 3, labelled in the grid', { hiddenRows: sum.hiddenRows, hiddenCols: sum.hiddenCols });
  const cells = await c.inFrame(() => Object.fromEntries(['B2', 'C2', 'C3', 'C4', 'B5', 'B7', 'B8', 'B9', 'B11'].map((a) => [a, window.__sheet.cell('Summary', a)])));
  c.record(F, id, comp, 'exact stored and displayed values (formats, leading zeros, long ids, error)', cells.B2.display === '10.00' && cells.B2.stored === 10 && cells.C2.display === '007300' && cells.C3.stored === '123456789012345678901' && cells.C4.display === '1.23E-04' && cells.B8.display === '#DIV/0!' && cells.B11.display === '12.5%', "B2 '10.00'/10, C2 '007300', C3 21-digit text, C4 '1.23E-04', B8 '#DIV/0!', B11 '12.5%'", cells);
  c.record(F, id, comp, 'date serial shown with its format (1900 system)', /2001-02-12|2001-02-11/.test(cells.B9.display) && cells.B9.stored === 36934, "B9 displays its yyyy-mm-dd date; stored serial 36934", cells.B9);
  c.record(F, id, comp, 'formula with stored result shows that result', cells.B5.display === '60.00' && cells.B5.formula === 'SUM(B2:B4)', "B5 '60.00', formula SUM(B2:B4)", cells.B5);
  if (xls) c.record(F, id, comp, 'formula without stored result survives conversion', cells.B7.unavailable === true, 'B7 unavailable (FAILS when the converter recalculated and stored 20)', cells.B7);
  else c.record(F, id, comp, 'formula without stored result: formula + value unavailable, never a guess', cells.B7.unavailable === true && cells.B7.stored === null && cells.B7.display === '=B2*2' && (await c.inFrame(() => document.querySelectorAll('.value-unavailable').length)) >= 1, "B7 unavailable, stored null, shows '=B2*2' + 'value unavailable'", cells.B7);
  if (!xls) { const raw = await c.inFrame(() => window.__sheet.raw('Summary', 'B7')); c.record(F, id, 'SheetJS CE 0.20.3 (raw cell object)', 'parser output alone distinguishes an absent formula result', raw.v === null, 'raw B7.v is undefined (FAIL = parser reports v:0, so the adapter must key on t:"z")', raw); }
  c.record(F, id, comp, 'cell comment kept', cells.B2.comments?.[0]?.text === 'XLSX-COMMENT-TOKEN', 'B2 comment text', cells.B2.comments);
}

export default async function sheet(c, { full, skipLarge }) {
  let id = 'sheet/main.xlsx';
  await opens(c, F, id, C);
  await layout(c, F, id, C);
  if (!full) { await accepts(c, F, id, C, { kind: 'cell', sheet: 'Summary', ref: 'B7' }, 'Summary!B7', async () => (await c.inFrame(() => window.__r.sheet.selected?.addr)) === 'B7'); return; }
  await workbookChecks(c, id, C);
  const html = await c.inFrame(() => ({ img: window.__sheet.domHtmlHasImg(), text: window.__sheet.domText('A12') }));
  c.record(F, id, C, 'HTML-like cell text rendered as text, never markup', !html.img && html.text?.includes('<img'), 'no <img> inside grid cells; A12 text shows the literal markup', html);
  // targets
  await accepts(c, F, id, C, { kind: 'cell', sheet: 'Summary', ref: 'B7' }, 'Summary!B7', async () => (await c.inFrame(() => window.__r.sheet.selected?.addr)) === 'B7');
  await accepts(c, F, id, C, { kind: 'cell', sheet: 'Summary', ref: 'B2:C4' }, 'Summary!B2:C4', async () => (await c.inFrame(() => [window.__r.sheet.selected?.addr, document.querySelectorAll('.cell-target').length])).join() === 'B2:C4,6');
  await accepts(c, F, id, C, { kind: 'cell', sheet: 'VeryHidden', ref: 'A1' }, 'very hidden', async () => (await c.inFrame(() => window.__r.sheet.active)) === 'VeryHidden');
  await accepts(c, F, id, C, { kind: 'cell', sheet: 'Summary', ref: 'Z500' }, 'outside the used range', null);
  await rejects(c, F, id, C, [[{ kind: 'cell', sheet: 'summary', ref: 'A1' }, 'invalid-target'], [{ kind: 'cell', sheet: 'Nope', ref: 'A1' }, 'invalid-target'], [{ kind: 'cell', sheet: 'Summary', ref: 'XFE1' }, 'invalid-target'], [{ kind: 'cell', sheet: 'Summary', ref: 'A1048577' }, 'invalid-target'], [{ kind: 'cell', sheet: 'Summary', ref: 'B2:C4:D5' }, 'invalid-target']], sel(c));
  // search across sheets, including hidden content
  for (const [q, want] of [['XLSX-VERY-HIDDEN-TOKEN', 'VeryHidden!A1'], ['XLSX-HIDDEN-ROW-TOKEN', 'Summary!A6'], ['XLSX-HIDDEN-COLUMN-TOKEN', 'Summary!D2'], ['B2*2', 'Summary!B7']]) {
    await c.frame().fill('#find', q);
    await c.frame().press('#find', 'Enter');
    await sleep(250);
    const s = await c.inFrame(() => ({ search: window.__r.sheet.search, active: window.__r.sheet.active, selected: window.__r.sheet.selected?.addr }));
    c.record(F, id, C, `search all sheets finds ${q}`, s.search?.hits?.[0] === want && `${s.active}!${s.selected}` === want, `first hit ${want} and the grid moves there`, s);
  }
  // keyboard: tabs and grid
  await c.navigate({ kind: 'cell', sheet: 'Summary', ref: 'A1' });
  await c.frame().focus('#tab-0');
  await c.page.keyboard.press('ArrowRight');
  await sleep(300);
  const tabK = await c.inFrame(() => [window.__r.sheet.active, document.activeElement?.id]);
  await c.frame().focus('#grid');
  await c.navigate({ kind: 'cell', sheet: 'Summary', ref: 'B2' });
  await c.frame().focus('#grid');
  await c.page.keyboard.press('ArrowDown');
  await c.page.keyboard.press('ArrowRight');
  await sleep(200);
  const gridK = await c.inFrame(() => window.__r.sheet.selected?.addr);
  c.record(F, id, C, 'keyboard: arrow keys switch sheet tabs and move the selected cell', tabK.join() === 'HiddenSheet,tab-1' && gridK === 'C3', 'ArrowRight on tab 0 -> HiddenSheet focused; B2 + Down + Right -> C3', { tabK, gridK });
  await keyboardRoundTrip(c, F, id, C);

  id = 'sheet/main-1904.xlsx';
  await opens(c, F, id, C);
  const d1904 = await c.inFrame(() => [window.__r.sheet.date1904, window.__sheet.cell('Summary', 'B9')]);
  c.record(F, id, C, '1904 date system detected and applied', d1904[0] === true && /2005-02-1[23]/.test(d1904[1].display), "date1904 true; serial 36934 displays as a 2005 date", d1904);

  id = 'sheet/main.xls';
  await opens(c, F, id, C);
  await workbookChecks(c, id, C, { xls: true });

  id = 'sheet/data.csv';
  await opens(c, F, id, C);
  const csv = await c.inFrame(() => Object.fromEntries(['A1', 'A2', 'B2', 'C2', 'D2', 'A3', 'B3', 'C3', 'D3', 'E2', 'F2'].map((a) => [a, window.__sheet.cell('Sheet1', a)])));
  c.record(F, id, 'SheetJS CE 0.20.3 (raw CSV) + Tabulator 6.6.1', 'CSV raw strings: BOM stripped, leading zeros, Unicode, quoted comma/newline/quotes, formula-like text inert', csv.A1.display === 'id' && csv.A2.display === '007' && csv.A3.display === '0042' && csv.B2.display === 'Zoë Müller' && csv.C2.display === 'comma, inside' && csv.B3.display === 'Line\nbreak' && csv.C3.display === 'quote "inner"' && csv.D2.display === '=1+1' && csv.D2.formula === null, "A1 'id', A2 '007', B3 contains a newline, D2 '=1+1' as text with no formula", csv);
  const em = await c.inFrame(() => [window.__sheet.cell('Sheet1', 'E3'), window.__sheet.cell('Sheet1', 'F3')]);
  c.record(F, id, 'SheetJS CE 0.20.3 (raw CSV) + Tabulator 6.6.1', 'CSV quoted empty field ("") distinguishable from a missing field', em[0].empty !== em[1].empty, 'E3 ("") and F3 (missing) differ in the model', { E3: em[0], F3: em[1] });

  id = 'sheet/chart.xlsx';
  await opens(c, F, id, C);
  const ch = await c.inFrame(() => ({ notice: document.querySelectorAll('[data-supplement]').length, text: document.body.innerText.includes('XLSX-CHART-TITLE') }));
  c.record(F, id, C, 'grid cannot show the chart; the reader points at the prepared supplement', ch.notice === 1 && !ch.text, 'one supplement notice; chart title absent from the grid', ch);
  const sup = await opens(c, F, 'sheet/chart.supplement-v1.pdf', 'prepared supplement PDF + pdf.js');
  c.record(F, 'sheet/chart.supplement-v1.pdf', 'prepared supplement PDF + pdf.js', 'chart supplement opens in the PDF reader', sup.type === 'ready', 'ready', null);
  const ms = await opens(c, F, 'sheet/main.supplement-v1.pdf', 'prepared supplement PDF + pdf.js');
  const mtext = ms.type === 'ready' ? await c.inFrame(async () => { const o = []; for (let n = 1; n <= window.__r.pdf.numPages; n++) o.push(await window.__pdf.textOf(n)); return o.join(' '); }) : '';
  c.record(F, 'sheet/main.supplement-v1.pdf', 'prepared supplement PDF (LibreOffice)', 'office-rendered supplement preserves the absent formula result', !/Double \(no cached result\)\s*20\b/.test(mtext) && !/\b20\b/.test(mtext.split('Double')[1]?.slice(0, 40) ?? ''), 'row 7 must not show a computed 20 (FAIL = converter recalculated)', mtext.slice(0, 300));
  c.record(F, 'sheet/main.supplement-v1.pdf', 'prepared supplement PDF (LibreOffice)', 'office-rendered supplement shows hidden sheets, rows, columns and comments', ['XLSX-HIDDEN-SHEET-TOKEN', 'XLSX-VERY-HIDDEN-TOKEN', 'XLSX-HIDDEN-ROW-TOKEN', 'XLSX-HIDDEN-COLUMN-TOKEN', 'XLSX-COMMENT-TOKEN'].every((t) => mtext.includes(t)), 'all hidden-content and comment tokens present (FAIL = print output omits them)', ['XLSX-HIDDEN-SHEET-TOKEN', 'XLSX-VERY-HIDDEN-TOKEN', 'XLSX-HIDDEN-ROW-TOKEN', 'XLSX-HIDDEN-COLUMN-TOKEN', 'XLSX-COMMENT-TOKEN'].filter((t) => !mtext.includes(t)));
  const alone = await importOnly(c.store, id);
  const withSup = c.descriptors.get(id);
  c.record(F, id, 'candidate import', 'chart without a supplement is held; with one it is not', withSup.visualParts?.length > 0 && withSup.holds.every((h) => h.code !== 'sheet-visual-content-needs-supplement') && alone.holds.some((h) => h.code === 'sheet-visual-content-needs-supplement'), 'chart parts detected; imported alone it holds sheet-visual-content-needs-supplement; with the linked supplement it does not', { visualParts: withSup.visualParts, withSupplement: withSup.holds, alone: alone.holds });

  if (!skipLarge) for (const [fid, cells] of [['sheet/large-100k-cells.xlsx', '100k'], ['sheet/large-1m-cells.xlsx', '1m']]) {
    const r = await c.open(fid, { kind: 'file' }, { timeoutMs: 120000 });
    const st = r.type === 'ready' ? (await c.rstate()).sheet : null;
    let searchMs = null, jump = null;
    if (st) {
      const last = cells === '100k' ? 'A10000' : 'A100000';
      const t0 = Date.now();
      await c.frame().fill('#find', cells === '100k' ? 'ROW-0010000' : 'ROW-0100000');
      await c.frame().press('#find', 'Enter');
      await c.inFrame(async () => { for (let i = 0; i < 600; i++) { if (window.__r.sheet.search?.index >= 0) return; await new Promise((r) => setTimeout(r, 100)); } });
      searchMs = Date.now() - t0;
      jump = await c.inFrame(() => window.__r.sheet.selected?.addr);
      c.record(F, fid, C, `${cells} populated cells: parse, grid, search and jump to the last row`, jump === last, `search finds ${last} and selects it`, { readyMs: r.ms, parseMs: st.parseMs, gridMs: st.gridMs, searchMs });
    } else c.record(F, fid, C, `${cells} populated cells: parse, grid, search and jump to the last row`, false, 'ready', { type: r.type, code: r.code, ms: r.ms });
  }
}
