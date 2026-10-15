import { desc, range, type Bundle, type Header } from './court.ts';
import { attr } from './download.ts';

const CSS = '.cbindex{font-family:Verdana,Geneva,sans-serif;font-size:13px;line-height:1.9;color:#111;background:#fff;padding:8px 2px}.cbindex p{margin:0;font-weight:700}.cbindex p.c{text-align:center}.cbindex p.cn{text-align:right;font-size:12px}.cbindex p.pt{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}.cbindex p.pt span:first-child{white-space:pre-line}.cbindex p.pt span:last-child{white-space:nowrap}.cbindex p.bt{margin-top:14px}.cbindex p.bt2{font-size:12px}.cbixt{border-collapse:collapse;width:100%;margin-top:6px}.cbixt td{border:1px solid #000;padding:6px 8px;font-weight:700;vertical-align:top;text-align:justify}.cbixt td.c{text-align:center;white-space:nowrap}.cbixt td:first-child{width:9%}.cbixt td:last-child{width:20%}';

export function indexHtml(b: Bundle, h: Header): string {
	const rows = b.rows.length ? b.rows.map((r) => `<tr><td class="c">${attr(r.n)}.</td><td>${attr(desc(r))}</td><td class="c">${attr(range(r))}</td></tr>`).join('') : '<tr><td colspan="3">No items.</td></tr>';
	return `<!doctype html><html><head><meta charset="utf-8"><title>Index — ${attr(b.title)}</title><style>${CSS}body{margin:28mm 24mm}</style></head><body><div class="cbindex">`
		+ `<p class="c">${attr(h.court)}</p><p class="c">${attr(h.judge)}</p><p class="cn">${attr(h.caseNo ? 'CASE NUMBER: ' + h.caseNo : '')}</p><p>&nbsp;</p><p>${attr(h.intro)}</p><p>&nbsp;</p>`
		+ `<p class="pt"><span>${attr(h.claimant)}</span><span>${attr(h.claimantRole)}</span></p><p>&nbsp;</p><p>and</p><p>&nbsp;</p><p class="pt"><span>${attr(h.defendant)}</span><span>${attr(h.defendantRole)}</span></p>`
		+ `<p>&nbsp;</p><p class="c bt">INDEX</p><p class="c bt2">${attr(b.title)}</p><p>&nbsp;</p><table class="cbixt"><tbody>${rows}</tbody></table></div></body></html>`;
}

export function printIndex(b: Bundle, h: Header): boolean {
	const w = window.open('', '_blank');
	if (!w) return false;
	w.document.write(indexHtml(b, h));
	w.document.close();
	setTimeout(() => { try { w.focus(); w.print(); } catch { /* closed */ } }, 350);
	return true;
}
