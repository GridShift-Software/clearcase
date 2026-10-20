// Synthetic workbooks written with the pinned SheetJS CE 0.20.3, then patched at the ZIP level where CE cannot write
// a feature (a chart part, an explicitly absent formula result).
import * as XLSX from 'xlsx';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';

function summarySheet() {
  const ws = {
    A1: { t: 's', v: 'Label' }, B1: { t: 's', v: 'Amount' }, C1: { t: 's', v: 'Identifier' }, D1: { t: 's', v: 'HiddenColumnHeader' },
    A2: { t: 's', v: 'Alpha' }, B2: { t: 'n', v: 10, z: '0.00', c: [{ a: 'Synthetic Reviewer', t: 'XLSX-COMMENT-TOKEN' }] }, C2: { t: 's', v: '007300' }, D2: { t: 's', v: 'XLSX-HIDDEN-COLUMN-TOKEN' },
    A3: { t: 's', v: 'Beta' }, B3: { t: 'n', v: 20, z: '0.00' }, C3: { t: 's', v: '123456789012345678901' },
    A4: { t: 's', v: 'Gamma' }, B4: { t: 'n', v: 30, z: '0.00' }, C4: { t: 'n', v: 0.000123, z: '0.00E+00' },
    A5: { t: 's', v: 'Total (cached)' }, B5: { t: 'n', v: 60, f: 'SUM(B2:B4)', z: '0.00' },
    A6: { t: 's', v: 'XLSX-HIDDEN-ROW-TOKEN' }, B6: { t: 'n', v: 1 },
    A7: { t: 's', v: 'Double (no cached result)' }, B7: { t: 'n', f: 'B2*2' },
    A8: { t: 's', v: 'Error' }, B8: { t: 'e', v: 0x07, w: '#DIV/0!' },
    A9: { t: 's', v: 'Date' }, B9: { t: 'n', v: 36934, z: 'yyyy-mm-dd' },
    A10: { t: 's', v: 'XLSX-MERGED-TOKEN' },
    A11: { t: 's', v: 'Share' }, B11: { t: 'n', v: 0.125, z: '0.0%' },
    A12: { t: 's', v: '<img src=x onerror=fetch("http://canary.invalid/cell")>XLSX-HTML-LIKE-TOKEN' },
    '!ref': 'A1:D12',
    '!merges': [XLSX.utils.decode_range('A10:C10')],
    '!rows': [, , , , , { hidden: true }],
    '!cols': [, , , { hidden: true }],
  };
  ws.B2.c.hidden = true;
  return ws;
}

export function mainWorkbook(bookType, date1904 = false) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summarySheet(), 'Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['XLSX-HIDDEN-SHEET-TOKEN', 42]]), 'HiddenSheet');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['XLSX-VERY-HIDDEN-TOKEN', 43]]), 'VeryHidden');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Notes'], ['XLSX-NOTES-TOKEN']]), 'Notes Ü');
  wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }, { Hidden: 2 }, { Hidden: 0 }], WBProps: { date1904 } };
  const out = XLSX.write(wb, { bookType, type: 'buffer', cellStyles: true, compression: true });
  return bookType === 'xlsx' ? stripCachedValue(new Uint8Array(out), 'B7') : new Uint8Array(out);
}

/** Make sure a formula cell carries no stored result, whatever the writer did. */
function stripCachedValue(bytes, ref) {
  const files = unzipSync(bytes);
  const name = 'xl/worksheets/sheet1.xml';
  const xml = strFromU8(files[name]);
  // CE writes t="e" for a formula cell without a value; Excel-family writers emit a bare <f> with no type or <v>
  const re = new RegExp(`<c r="${ref}"([^>]*)>(<f>[^<]*</f>)(?:<v>[^<]*</v>)?</c>`);
  const patched = xml.replace(re, (_, attrs, f) => `<c r="${ref}"${attrs.replace(/ t="[^"]*"/, '')}>${f}</c>`);
  if (patched === xml) throw new Error(`stripCachedValue: ${ref} not found as a formula cell`);
  files[name] = strToU8(patched);
  return zipSync(files, { level: 6 });
}

/** A workbook with one bar chart over Summary!B2:B4: the grid cannot show it, so import must demand a supplement. */
export function chartWorkbook() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Label', 'Amount'], ['Alpha', 10], ['Beta', 20], ['Gamma', 30]]), 'Summary');
  const files = unzipSync(new Uint8Array(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' })));
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const sheet = strFromU8(files['xl/worksheets/sheet1.xml']).replace('</worksheet>', `<drawing r:id="rIdDr" xmlns:r="${R}"/></worksheet>`);
  files['xl/worksheets/sheet1.xml'] = strToU8(sheet.includes('xmlns:r=') ? sheet : sheet);
  files['xl/worksheets/_rels/sheet1.xml.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDr" Type="${R}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`);
  files['xl/drawings/drawing1.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>10</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>16</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="XLSX-CHART-TOKEN"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${R}" r:id="rIdCh"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`);
  files['xl/drawings/_rels/drawing1.xml.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdCh" Type="${R}/chart" Target="../charts/chart1.xml"/></Relationships>`);
  files['xl/charts/chart1.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>XLSX-CHART-TITLE</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:cat><c:strRef><c:f>Summary!$A$2:$A$4</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Summary!$B$2:$B$4</c:f></c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:crossAx val="1"/></c:valAx></c:plotArea></c:chart></c:chartSpace>`);
  const ct = strFromU8(files['[Content_Types].xml']).replace('</Types>', '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>');
  files['[Content_Types].xml'] = strToU8(ct);
  return zipSync(files, { level: 6 });
}

/** rows x cols populated numeric/text cells, for the POC-scale load tiers. */
export function largeWorkbook(rows, cols) {
  const ws = {};
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const a = XLSX.utils.encode_cell({ r, c });
    ws[a] = c === 0 ? { t: 's', v: `ROW-${String(r + 1).padStart(7, '0')}` } : { t: 'n', v: r * cols + c };
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows - 1, c: cols - 1 } });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Large');
  return new Uint8Array(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer', compression: true }));
}

export const CSV = '﻿id,name,note,formula_like,empty,missing\r\n007,Zoë Müller,"comma, inside","=1+1",,\r\n0042,"Line\nbreak","quote ""inner""","=HYPERLINK(""http://canary.invalid/csv"")",""\r\n';
