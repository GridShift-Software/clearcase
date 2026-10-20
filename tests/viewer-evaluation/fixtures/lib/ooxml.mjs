// Synthetic DOCX writer: every content kind the Word fixture table names carries a unique token, so a renderer's
// output can be checked token by token. External relationships point at canary.invalid (RFC 6761: never resolves).
import { zipSync, strToU8 } from 'fflate';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const p = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const drawing = (attr, id) => `<w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><wp:docPr id="${id}" name="Picture ${id}" descr="Synthetic picture ${id}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="p${id}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip ${attr}/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
const sect = (landscape, refs = '') => landscape
  ? `<w:sectPr>${refs}<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`
  : `<w:sectPr>${refs}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Liberation Serif" w:hAnsi="Liberation Serif"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr></w:style></w:styles>`;

function pack({ body, rels, extraFiles = {}, overrides = '', defaults = '' }) {
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${defaults}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>${overrides}</Types>`;
  const files = {
    '[Content_Types].xml': strToU8(ct),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`),
    'word/styles.xml': strToU8(STYLES),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/>${rels}</Relationships>`),
  };
  for (const [k, v] of Object.entries(extraFiles)) files[k] = typeof v === 'string' ? strToU8(v) : v;
  return zipSync(files, { level: 6, mtime: new Date(Date.UTC(2001, 0, 1)) });
}

/** The full-content DOCX: three expected pages (manual break, then a landscape section). */
export function fullDocx(png) {
  const body = [
    p('WORD-P1-HEADING', 'Heading1'),
    `<w:p><w:r><w:t xml:space="preserve">Body paragraph WORD-P1-BODY with a footnote</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r></w:p>`,
    `<w:p><w:commentRangeStart w:id="0"/><w:r><w:t xml:space="preserve">Commented span WORD-COMMENTED-SPAN</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>`,
    `<w:p><w:r><w:t xml:space="preserve">Tracked: </w:t></w:r><w:ins w:id="10" w:author="Synthetic Reviewer" w:date="2001-01-01T00:00:00Z"><w:r><w:t xml:space="preserve">WORD-INSERTED-TOKEN </w:t></w:r></w:ins><w:del w:id="11" w:author="Synthetic Reviewer" w:date="2001-01-01T00:00:00Z"><w:r><w:delText xml:space="preserve">WORD-DELETED-TOKEN</w:delText></w:r></w:del></w:p>`,
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>${['1', '2'].map((r) => `<w:tr>${['A', 'B'].map((c) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${p(`WORD-TABLE-${c}${r}`)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`,
    `<w:p>${drawing('r:embed="rIdImg"', 1)}</w:p>`,
    `<w:p>${drawing('r:link="rIdExtImg"', 2)}</w:p>`,
    `<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>WORD-EXTERNAL-LINK</w:t></w:r></w:hyperlink></w:p>`,
    `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`,
    p('WORD-P2-BODY after a manual page break'),
    `<w:p><w:pPr>${sect(false, '<w:headerReference w:type="default" r:id="rIdHdr"/><w:footerReference w:type="default" r:id="rIdFtr"/>')}</w:pPr></w:p>`,
    p('WORD-P3-LANDSCAPE in a landscape section'),
    sect(true, '<w:headerReference w:type="default" r:id="rIdHdr"/><w:footerReference w:type="default" r:id="rIdFtr"/>'),
  ].join('');
  const rels = `<Relationship Id="rIdImg" Type="${REL}/image" Target="media/image1.png"/><Relationship Id="rIdExtImg" Type="${REL}/image" Target="http://canary.invalid/docx-external-image.png" TargetMode="External"/><Relationship Id="rIdLink" Type="${REL}/hyperlink" Target="http://canary.invalid/docx-link" TargetMode="External"/><Relationship Id="rIdHdr" Type="${REL}/header" Target="header1.xml"/><Relationship Id="rIdFtr" Type="${REL}/footer" Target="footer1.xml"/><Relationship Id="rIdFn" Type="${REL}/footnotes" Target="footnotes.xml"/><Relationship Id="rIdCm" Type="${REL}/comments" Target="comments.xml"/>`;
  return pack({
    body, rels,
    overrides: '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>',
    extraFiles: {
      'word/media/image1.png': png,
      'word/header1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W}>${p('WORD-HEADER-TOKEN')}</w:hdr>`,
      'word/footer1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${W}><w:p><w:r><w:t xml:space="preserve">WORD-FOOTER-TOKEN page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`,
      'word/footnotes.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${W}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1">${p('WORD-FOOTNOTE-TOKEN')}</w:footnote></w:footnotes>`,
      'word/comments.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W}><w:comment w:id="0" w:author="Synthetic Reviewer" w:date="2001-01-01T00:00:00Z" w:initials="SR">${p('WORD-COMMENT-TOKEN')}</w:comment></w:comments>`,
    },
  });
}

/** altChunk: embedded HTML with a script, a remote image and a form; must never run or fetch. */
export function altChunkDocx() {
  const html = '<html><body><p>ALTCHUNK-HTML-TOKEN</p><script>fetch("http://canary.invalid/altchunk-script")</script><img src="http://canary.invalid/altchunk-image.png"><form action="http://canary.invalid/altchunk-form"><input name="q"></form></body></html>';
  return pack({
    body: p('ALTCHUNK-HOST-TOKEN') + '<w:altChunk r:id="rIdAlt"/>' + sect(false),
    rels: `<Relationship Id="rIdAlt" Type="${REL}/aFChunk" Target="afchunk.html"/>`,
    defaults: '<Default Extension="html" ContentType="text/html"/>',
    extraFiles: { 'word/afchunk.html': html },
  });
}
