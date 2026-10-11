// The Word index of one or more bundles (v5 cbDocx L2471-2568): same paragraphs, table and package parts. Hyperlinks
// into the shipped bundle PDFs are left out: those PDFs are not in the verified index (see the CC-09 report). The
// builder's index links into the bundle it just assembled (v5 cbCell/cbDocHref L2426-2460), when asked.
import { desc, range, type Bundle, type Header } from './court.ts';
import { storedZip } from './zip.ts';

/**
 * XML 1.0 text (CC-09-r2 D11): a vertical tab (Word's pasted manual line break) or a form feed becomes a space (a line
 * break in the multi-line header fields, see lines()), other characters outside the XML Char range (C0 controls, U+FFFE,
 * U+FFFF) are dropped and a lone surrogate becomes U+FFFD; then v5's cbX escape. The stored values stay as typed.
 */
export const xmlText = (s: unknown) => String(s ?? '').toWellFormed().replace(/[\u000B\u000C]/g, ' ').replace(/[\u0000-\u0008\u000E-\u001F\uFFFE\uFFFF]/g, '');
const x = (s: unknown) => xmlText(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const RPR = '<w:rPr><w:rFonts w:ascii="Verdana" w:hAnsi="Verdana" w:cs="Arial"/><w:b/></w:rPr>';
interface P { jc?: string; tabPos?: number; tabRight?: string; pageBreakBefore?: boolean }
function p(text: string, o: P = {}): string {
	const jc = o.jc ? `<w:jc w:val="${o.jc}"/>` : '';
	const tabs = o.tabPos ? `<w:tabs><w:tab w:val="right" w:pos="${o.tabPos}"/></w:tabs>` : '';
	const br = o.pageBreakBefore ? '<w:pageBreakBefore/>' : '';
	let runs = '';
	if (o.tabRight) runs = `<w:r>${RPR}<w:t xml:space="preserve">${x(text)}</w:t></w:r><w:r>${RPR}<w:tab/><w:t xml:space="preserve">${x(o.tabRight)}</w:t></w:r>`;
	else if (text !== '') runs = `<w:r>${RPR}<w:t xml:space="preserve">${x(text)}</w:t></w:r>`;
	return `<w:p><w:pPr>${br}${tabs}<w:spacing w:line="276" w:lineRule="auto"/>${jc}${RPR}</w:pPr>${runs}</w:p>`;
}
interface Rels { n: number; rels: { id: string; target: string }[] }
/** v5 cbCell: with `href`, the text is a hyperlink (relationship rIdH<n>), blue and underlined when `blue`. */
function cell(text: string, w: number, jc: string, lnk?: { ctx: Rels; href: string; blue: boolean }): string {
	let run = '';
	if (text !== '' && lnk?.href) {
		const id = 'rIdH' + ++lnk.ctx.n;
		lnk.ctx.rels.push({ id, target: lnk.href });
		const rpr = `<w:rPr><w:rFonts w:ascii="Verdana" w:hAnsi="Verdana" w:cs="Arial"/><w:b/>${lnk.blue ? '<w:color w:val="0D3399"/><w:u w:val="single"/>' : ''}</w:rPr>`;
		run = `<w:hyperlink r:id="${id}"><w:r>${rpr}<w:t xml:space="preserve">${x(text)}</w:t></w:r></w:hyperlink>`;
	} else if (text !== '') run = `<w:r>${RPR}<w:t xml:space="preserve">${x(text)}</w:t></w:r>`;
	return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:spacing w:line="360" w:lineRule="auto"/><w:jc w:val="${jc}"/>${RPR}</w:pPr>${run}</w:p></w:tc>`;
}
/** v5 cbDocHref for an assembled bundle: its file at the item's physical page (index pages in front), no leading './'. */
const docHref = (b: Bundle, r: Bundle['rows'][number]) => (b.file && r.from ? `${b.file}#page=${r.from + (b.indexPages || 0)}` : '').replace(/^\.\//, '');
const lines = (t: string) => String(t ?? '').split(/\r?\n|[\u000B\u000C]/);
const pml = (t: string, o: P = {}) => lines(t).map((l, i) => p(l, { ...o, pageBreakBefore: i === 0 && !!o.pageBreakBefore })).join('');
const party = (name: string, role: string) => { const ls = lines(name); return p(ls[0] || '', { tabRight: role || '', tabPos: 9360 }) + ls.slice(1).map((l) => p(l)).join(''); };
const BORDERS = '<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>';

function bundleXml(b: Bundle, h: Header, first: boolean, ctx: Rels | null): string {
	let s = pml(h.court, { jc: 'center', pageBreakBefore: !first }) + pml(h.judge, { jc: 'center' });
	if (h.caseNo) s += p('CASE NUMBER: ' + h.caseNo, { jc: 'right' });
	s += p('') + p(h.intro) + p('') + party(h.claimant, h.claimantRole) + p('') + p('and') + p('') + party(h.defendant, h.defendantRole) + p('');
	s += p('INDEX', { jc: 'center' }) + p(b.title || b.name || '', { jc: 'center' }) + p('');
	s += `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${BORDERS}</w:tblBorders><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid><w:gridCol w:w="846"/><w:gridCol w:w="6237"/><w:gridCol w:w="1933"/></w:tblGrid>`;
	for (const r of b.rows) {
		const href = ctx ? docHref(b, r) : '';
		const lnk = (blue: boolean) => (ctx && href ? { ctx, href, blue } : undefined);
		s += `<w:tr><w:trPr><w:trHeight w:val="403"/></w:trPr>${cell(r.n + '.', 846, 'center')}${cell(desc(r), 6237, 'both', lnk(false))}${cell(range(r), 1933, 'center', lnk(true))}</w:tr>`;
	}
	return s + '</w:tbl>' + p('');
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
/** The DOCX bytes for these bundles' indexes under one header; `creator` is the package's wording or a neutral one.
 * With `links`, rows of a bundle with a `file` link into it. */
export function indexDocx(bundles: readonly Bundle[], h: Header, creator: string, links = false): Uint8Array {
	const ctx: Rels | null = links ? { n: 0, rels: [] } : null;
	const body = bundles.map((b, i) => bundleXml(b, h, i === 0, ctx)).join('') + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1440" w:bottom="709" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr>';
	const doc = XML + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14"><w:body>' + body + '</w:body></w:document>';
	const ct = XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
	const rels = XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>';
	const drels = XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' + (ctx?.rels ?? []).map((rl) => `<Relationship Id="${rl.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${x(rl.target)}" TargetMode="External"/>`).join('') + '</Relationships>';
	const styles = XML + `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-ZA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders>${BORDERS}</w:tblBorders></w:tblPr></w:style></w:styles>`;
	const title = bundles.length === 1 ? 'Index — ' + (bundles[0]!.title || bundles[0]!.name || '') : 'Court bundle indexes';
	const core = XML + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(title)}</dc:title><dc:creator>${x(creator)}</dc:creator><cp:lastModifiedBy>${x(creator)}</cp:lastModifiedBy></cp:coreProperties>`;
	const app = XML + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Office Word</Application></Properties>';
	const te = new TextEncoder();
	return storedZip([
		{ name: '[Content_Types].xml', data: te.encode(ct) }, { name: '_rels/.rels', data: te.encode(rels) }, { name: 'docProps/core.xml', data: te.encode(core) },
		{ name: 'docProps/app.xml', data: te.encode(app) }, { name: 'word/_rels/document.xml.rels', data: te.encode(drels) }, { name: 'word/document.xml', data: te.encode(doc) }, { name: 'word/styles.xml', data: te.encode(styles) },
	]);
}
export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
