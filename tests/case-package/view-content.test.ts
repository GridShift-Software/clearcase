// GRS-38: code-embedded view content carried as the `view-content` dataset. Synthetic,
// invented v5-shaped viewer code only (fixtures/view-code.synthetic.js.txt).
import { afterAll, describe, expect, it } from 'vitest';
import { readViewContent, renderNarrative, revealInvisible } from '../../src/lib/case-package/browser.ts';
import { DiagSink } from '../../src/lib/case-package/diagnostics.ts';
import { sha256Hex } from '../../src/lib/case-package/hash.ts';
import { importCandidate } from '../../src/lib/case-package/import.ts';
import { VIEW_CONTENT } from '../../src/lib/case-package/registry.ts';
import { convertV5 } from '../../src/lib/case-package/v5/adapter.ts';
import { markupText, tokenize } from '../../src/lib/case-package/v5/js-scan.ts';
import { reassembleV5 } from '../../src/lib/case-package/source-layout.ts';
import { checkMap, extractViewContent, type Entry } from '../../src/lib/case-package/v5/view-content.ts';
import { SHELL_VIEW, V5_VIEW_IDS, VIEW_CONTENT_AUDIT, VIEW_CONTENT_MAP, VIEW_CONTENT_OMISSIONS } from '../../src/lib/case-package/v5/view-content-map.ts';
import { cleanup, SYNTH_VIEW_CODE, synthHtml, synthRoots, tempDir, writeCaseFolder, type SynthRoots } from './fixtures/synth.ts';

const dec = new TextDecoder();
const htmlOf = (code: string | false = SYNTH_VIEW_CODE, edit?: (r: SynthRoots) => void) => {
  const r = synthRoots();
  edit?.(r);
  return synthHtml(r, [], { viewCode: code });
};
function extract(code: string | false = SYNTH_VIEW_CODE, entries: readonly Entry[] = VIEW_CONTENT_MAP, edit?: (r: SynthRoots) => void) {
  const html = dec.decode(htmlOf(code, edit));
  const skipLines = html.split('\n').flatMap((l, i) => (/^(?:const (?:DATA|META)|window\.__\w+__) = /.test(l) ? [i + 1] : []));
  const sink = new DiagSink();
  const r = extractViewContent(html, entries, VIEW_CONTENT_OMISSIONS, { skipLines, audit: VIEW_CONTENT_AUDIT, sink });
  return { ...r, diagnostics: sink.finish() };
}
const swap = (from: string, to: string) => {
  if (!SYNTH_VIEW_CODE.includes(from)) throw new Error(`fixture lacks ${from}`);
  return SYNTH_VIEW_CODE.replace(from, to);
};
const entry = (view: string, field: string) => VIEW_CONTENT_MAP.filter((e) => e.view === view && e.field === field);

const roots: string[] = [];
async function caseDir(tag: string): Promise<string> {
  const root = await tempDir(tag);
  roots.push(root);
  await writeCaseFolder(`${root}/case`);
  return `${root}/case`;
}
afterAll(async () => { for (const r of roots) await cleanup(r); });

describe('view-content extraction', () => {
  it('extracts every map entry from v5-shaped code, leaving no prose literal unmapped', () => {
    const r = extract();
    expect(r.fields.filter((f) => f.status !== 'extracted')).toEqual([]);
    expect(r.unmapped).toEqual([]);
    expect(r.diagnostics).toEqual([]);
    expect(Object.values(r.data).reduce((n, v) => n + Object.keys(v).length, 0)).toBe(VIEW_CONTENT_MAP.length);
  });

  it('carries the legality docs card caption (a template on the document count) and the scenario action heading (GRS-45)', () => {
    const { data, fields } = extract();
    expect(fields.filter((f) => f.view === 'legality_tab' && f.field !== 'subtitle').map((f) => [f.field, f.status])).toEqual([['docsHeading', 'extracted'], ['scenarioActionHeading', 'extracted']]);
    expect(data.legality_tab!.docsHeading).toEqual({ template: ['Invented review documents in the bundle (', { param: 'count' }, ')'] });
    expect(data.legality_tab!.scenarioActionHeading).toBe('Org A action');
  });

  it('reads every value kind: text, markup text, template, number, list', () => {
    const { data } = extract();
    expect(data.overview!.subtitle).toBe('Synthetic Holdings Ltd v Example Department');
    expect(data.overview!.kpiDocumentsNote).toBe('across 2 invented bundles');
    expect(data.caselines_tab!.subtitle).toBe('The invented bundle (Invented & Folder)');
    expect(data.timeline!.narrative).toBe('An invented supplier & an invented customer disagree about “invented” invoices.');
    expect(data.discovery_tab!.plaintiffCitation).toBe('SYNTHETIC HOLDINGS LTD\n[Invented registration]');
    expect(data.discovery_tab!.discoveryModeLabel).toBe('Invented Affidavit (1–3)');
    expect(data.discovery_tab!.supplementaryRange).toBe('Items 1 – 2');
    expect(data.timeline!.synopsis).toEqual({ template: ['Drawn from ', { param: 'docCount' }, ' documents (Original ', { param: 'original' }, ', Supplementary ', { param: 'supplementary' },
      ', Correspondence ', { param: 'correspondence' }, '), spanning ', { param: 'dateFrom' }, ' to ', { param: 'dateTo' }, '.'] });
    expect(data.invoice_ledger_tab!.subtitle).toEqual({ template: [{ param: 'count' }, ' SYN-series invoices'] });
    expect(data.caselines_tab!.heroNote).toEqual({ template: ['Invented bundle · ', { param: 'pages' }, ' pages (XX-001)'] });
    expect(data.interest_calc_tab!.defaultRate).toBe(7.25);
    expect(data.court_bundle_tab!.kpiExtractsValue).toBe(4);
    expect(data.caselines_tab!.pageCountFallback).toBe(12);
    expect(data.settlement_tab!.defaultEnforcementCost).toBe(1000);
    expect(data.vdm_matrix_tab!.columns).toEqual(['ORG point', 'Documents', 'SYN rebuttal']);
    expect(data.deadlines_tab!.icsProductId).toBe('SYN v ORG');
    expect(data.rescan_tab!.invoicePrefix).toBe('syn');
    expect(data.heads_tab!.exportCaption).toBe('SYN v ORG');
    expect(data.court_bundle_tab!.compositionSourceDefault).toBe('INVENTED LIST.docx');
    expect(data.court_bundle_tab!.docxCreator).toBe('SYN v ORG Workspace');
    expect(data.discovery_tab!.bundleIndexName).toBe('SYN v ORG - Court Bundle Index');
    expect(data[SHELL_VIEW]!.documentTitle).toBe('SYN v ORG — Synthetic workspace');
    expect(data[SHELL_VIEW]!.brandName).toBe('SYN v ORG');
    expect(data.conflict_tab!.queryPlaceholder).toBe('e.g. Invented Ltd, person@example.invalid');
  });

  it('reports a missing anchor per required field and never guesses', () => {
    // no viewer code: only the page <title> (static markup) remains
    const none = extract(false);
    expect(none.data).toEqual({ [SHELL_VIEW]: { documentTitle: 'SYN v ORG — Synthetic workspace' } });
    const missing = none.diagnostics.filter((d) => d.code === 'V5_VIEW_CONTENT_MISSING');
    expect(missing.map((d) => d.subject).sort()).toEqual(VIEW_CONTENT_MAP.filter((e) => e.required && e.field !== 'documentTitle').map((e) => `${e.view}.${e.field}`).sort());
    expect(missing.every((d) => d.severity === 'warning' && d.file === 'input')).toBe(true);
    const one = extract(swap('id="ic_r" value="7.25"', 'id="ic_rate" value="7.25"'));
    expect(one.data.interest_calc_tab).toBeUndefined();
    expect(one.diagnostics.map((d) => [d.code, d.subject])).toEqual([['V5_VIEW_CONTENT_MISSING', 'interest_calc_tab.defaultRate']]);
  });

  it('reports an ambiguous anchor and extracts nothing for it', () => {
    const twice = extract(swap("let h=pageHead('Legality','Could an invented review change the claim?');", "let h=pageHead('Legality','One');h+=pageHead('Legality','Two');"));
    expect(twice.data.legality_tab?.subtitle).toBeUndefined();
    expect(twice.diagnostics.map((d) => [d.code, d.subject])).toEqual([['V5_VIEW_CONTENT_AMBIGUOUS', 'legality_tab.subtitle']]);
    const bindings = extract(swap('const q=DATA.quantum;\n  const kpis=[', "const kpis=[['x','y','z']];\n  const q=DATA.quantum;\n  const kpis=["));
    expect(bindings.data.overview).toEqual({ subtitle: 'Synthetic Holdings Ltd v Example Department' });
    expect(bindings.diagnostics.filter((d) => d.code === 'V5_VIEW_CONTENT_AMBIGUOUS').map((d) => d.subject)).toEqual(['overview.kpiDocumentsNote', 'overview.kpiInvoicesNote']);
  });

  it('refuses a value whose shape differs from the map: code where text is expected, a missing or rebound interpolation', () => {
    const code = extract(swap("pageHead('Overview','Synthetic Holdings Ltd v Example Department')", "pageHead('Overview',esc(DATA.matter.title))"));
    expect(code.data.overview!.subtitle).toBeUndefined();
    expect(code.diagnostics[0]!.message).toMatch(/expected literal text, found code/);
    const noParam = extract(swap("'SYN v ORG — an invented write-up built from '+META.docCount.toLocaleString()+' invented documents'", "'SYN v ORG — an invented write-up'"));
    expect(noParam.data.timeline!.subtitle).toBeUndefined();
    expect(noParam.diagnostics[0]!.message).toMatch(/expected 1 interpolations, found 0/);
    const rebound = extract(swap("<p>About <b>'+META.textNone+'</b>", "<p>About <b>'+META.emails+'</b>"));
    expect(rebound.data.timeline!.evidenceNotes).toBeUndefined();
    expect(rebound.diagnostics[0]!.message).toMatch(/does not read META\.textNone/);
  });

  it('keeps hostile values as inert text and never executes the code', async () => {
    const hostile = swap("plaintiff:'SYNTHETIC HOLDINGS LTD',", "plaintiff:'\\u003cscript\\u003ealert(1)\\u003c/script\\u003e \\u202eLTD {\"param\":\"x\"} ${x}',")
      .replace('<p>An invented counsel note.</p>', '<p>&lt;img src=x onerror=alert(1)&gt; <img src=x onerror=alert(2)>[[OD-001]] <script>alert(3)<\\/script>javascript:alert(4)</p>')
      .replace("pageHead('Legality','Could an invented review change the claim?')", "pageHead('Legality',(function(){globalThis.__executed=true;return 'x';})())");
    const { data, diagnostics } = extract(hostile);
    expect(data.discovery_tab!.plaintiff).toBe('<script>alert(1)</script> ‮LTD {"param":"x"} ${x}');
    expect(data.contracts_tab!.counselNote).toBe('<img src=x onerror=alert(1)> [[OD-001]] javascript:alert(4)');
    expect(data.legality_tab?.subtitle).toBeUndefined();
    expect(diagnostics.map((d) => d.subject)).toEqual(['legality_tab.subtitle']);
    const html = renderNarrative(data.contracts_tab!.counselNote as string, { resolveCitationHref: () => '/v/x/doc/OD-001' });
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect((globalThis as Record<string, unknown>).__executed).toBeUndefined();

    // the converted package carries the values as untrusted text; the validator flags the bidi override
    const dir = await caseDir('vc-hostile');
    const conv = await convertV5({ html: htmlOf(hostile), htmlName: 'w.html', caseFolder: dir, caseId: 'hostile' });
    expect(conv.ok).toBe(true);
    const r = await importCandidate({ files: conv.files! }, dir);
    expect(r.verdict).not.toBe('reject');
    expect(r.diagnostics.some((d) => d.code === 'TEXT_CONTROL_CHARS' && d.file === 'datasets/view-content.json')).toBe(true);
  });

  it('rejects an unsafe locator in a link field through the existing link policy', async () => {
    const dir = await caseDir('vc-link');
    const conv = await convertV5({ html: htmlOf(swap("url:'./INVENTED%20FOLDER/INVENTED%20BUNDLE.pdf'", "url:'javascript:alert(1)'")), htmlName: 'w.html', caseFolder: dir, caseId: 'hostile-link' });
    const r = await importCandidate({ files: conv.files! }, dir);
    expect(r.verdict).toBe('reject');
    expect(r.diagnostics.some((d) => d.code === 'LINK_UNSAFE_SCHEME' && d.file === 'datasets/view-content.json')).toBe(true);
  });

  it('never reads view content from the data payload lines', () => {
    const lure = "RENDER.legality_tab=function(el){let h=pageHead('Legality','FROM THE DATA LINE');}";
    const r = extract(false, entry('legality_tab', 'subtitle'), (x) => { (x.DATA.chronology as Record<string, unknown>[])[0]!.excerpt = lure; });
    expect(r.data).toEqual({});
    expect(r.diagnostics.map((d) => d.code)).toEqual(['V5_VIEW_CONTENT_MISSING']);
  });

  it('tokenizes malformed or hostile code without throwing', () => {
    const pieces = ['"', "'", '`', '${', '}', '/', '/*', '*/', '//', '\\', '(', ')', '[', ']', '{', 'x', '1', '=', '+', '<p>', '\n', 'return', ' '];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let n = 0; n < 300; n++) {
      const src = Array.from({ length: 40 }, () => pieces[Math.floor(rnd() * pieces.length)]).join('');
      expect(() => tokenize(src)).not.toThrow();
      expect(() => extractViewContent(`<script>${src}</script>`, VIEW_CONTENT_MAP, VIEW_CONTENT_OMISSIONS, { audit: VIEW_CONTENT_AUDIT })).not.toThrow();
    }
    expect(tokenize("a = b / c / d; e = /x\\/[/]y/g.test(s); f = `t${`n${1}`}u`").filter((t) => t.t === 're').map((t) => t.v)).toEqual(['/x\\/[/]y/g']);
    expect(markupText('<p>One &amp; two<br>three</p><p>&#x41;&unknown;</p>')).toBe('One & two\nthree\n\nA&unknown;');
  });
});

describe('view-content extraction: review regressions', () => {
  const one = (script: string, e: Partial<Entry> & Pick<Entry, 'scope' | 'sel' | 'kind'>, markup = '') => {
    const sink = new DiagSink();
    const r = extractViewContent(`${markup}<script>${script}</script>`, [{ view: 'v', field: 'f', checklist: 'L1', required: true, ...e }], [], { sink });
    return { value: r.data.v?.f, status: r.fields[0]!.status, detail: r.fields[0]!.detail, codes: sink.finish().map((d) => d.code) };
  };
  it('refuses a literal that forges a code marker instead of crashing or borrowing a run', () => {
    for (const forged of ['&#xE000;0&#xE001;', '\\uE0000\\uE001', '\\uE002']) {
      const r = one(`RENDER.t=function(el){let h='<p>a ${forged} b '+META.docCount+'</p>';}`, { scope: 'render:t', sel: { html: 'p' }, kind: 'template', params: [{ name: 'docCount', expect: 'META.docCount' }] });
      expect([r.status, r.value]).toEqual(['shape', undefined]);
    }
  });
  it('joins markup only through the accumulator; another += or declaration is code', () => {
    const r = one("RENDER.t=function(el){let h='';h+='<p>Real';csv+=' FOREIGN';h+=' text</p>';h+='';}", { scope: 'render:t', sel: { html: 'p' }, kind: 'text' });
    expect([r.status, r.value]).toEqual(['shape', undefined]);
    const ok = one("RENDER.t=function(el){let h='';h+='<p>Real';h+=' text</p>';}", { scope: 'render:t', sel: { html: 'p' }, kind: 'text' });
    expect(ok.value).toBe('Real text');
  });
  it('reports a function or constant defined twice as ambiguous; RENDER keeps its live (last) definition', () => {
    const fn = one("function a(){function meta(){return {deed:'A'};}} function b(){function meta(){return {deed:'B'};}}", { scope: 'function:meta', sel: { lit: 'object', nth: 0, path: ['deed'] }, kind: 'text' });
    expect([fn.status, fn.codes]).toEqual(['ambiguous', ['V5_VIEW_CONTENT_AMBIGUOUS']]);
    const render = one("RENDER.t=function(el){pageHead('T','old');};RENDER.t=function(el){pageHead('T','live');};", { scope: 'render:t', sel: { call: 'pageHead', arg: 1 }, kind: 'text' });
    expect(render.value).toBe('live');
  });
  it('keeps array positions across holes and reports duplicate object keys', () => {
    expect(one("const X=['a', , 'c'];", { scope: 'const:X', sel: { lit: 'array', path: [2] }, kind: 'text' }).value).toBe('c');
    expect(one("const X=['a', , 'c'];", { scope: 'const:X', sel: { lit: 'array', path: [1] }, kind: 'text' }).status).toBe('shape');
    expect(one("const X={court:'first',court:'second'};", { scope: 'const:X', sel: { lit: 'object', path: ['court'] }, kind: 'text' }).status).toBe('ambiguous');
  });
  it('closes implied elements, reads ?? defaults and legacy octal, and keeps lower-precedence operators as code', () => {
    expect(one("RENDER.t=function(el){let h='<ul><li>one<li>two</ul>';}", { scope: 'render:t', sel: { html: 'li', all: true }, kind: 'list' }).value).toEqual(['one', 'two']);
    expect(one("const B={pages:(X&&X.pages)??42};", { scope: 'const:B', sel: { lit: 'object', path: ['pages'] }, kind: 'number', fallback: true }).value).toBe(42);
    expect(one("const B={pages:010};", { scope: 'const:B', sel: { lit: 'object', path: ['pages'] }, kind: 'number' }).value).toBe(8);
    expect(one("function f(){return 'T '+n-1;}", { scope: 'function:f', sel: { ret: 0 }, kind: 'template', params: [{ name: 'n', expect: 'n' }] }).status).toBe('shape');
  });
  it('stays linear on hostile markup and code', () => {
    const N = 20_000;
    const cases: [string, string, string][] = [
      ['many scripts', '', '<script>x</script>'.repeat(N)],
      ['many styles in static markup', '<style>a{}</style>'.repeat(N), ''],
      ['unterminated attribute', '<a '.repeat(N) + '"', ''],
      ['unmatched end tags', '<div>'.repeat(N) + '</span>'.repeat(N), ''],
      ['unclosed raw text', '<script '.repeat(N), ''],
    ];
    for (const [label, markup, script] of cases) {
      const t0 = performance.now();
      extractViewContent(`${markup}<script>${script}</script>`, [{ view: 'v', field: 'f', checklist: 'L1', scope: 'markup', sel: { html: 'title' }, kind: 'text', required: false }], []);
      markupText(markup);
      expect(performance.now() - t0, label).toBeLessThan(1500);
    }
  });
});

describe('view-content extraction: fix round regressions (CC-30 r2)', () => {
  const one = (script: string, e: Partial<Entry> & Pick<Entry, 'scope' | 'sel' | 'kind'>, opts: { markup?: string; audit?: boolean; maxChars?: number; deadlineMs?: number } = {}) => {
    const sink = new DiagSink();
    const r = extractViewContent(`${opts.markup ?? ''}<script>${script}</script>`, [{ view: 'v', field: 'f', checklist: 'L1', required: true, ...e }], [], { sink, ...(opts.audit && { audit: [e.scope] }), maxChars: opts.maxChars, deadlineMs: opts.deadlineMs });
    return { value: r.data.v?.f, status: r.fields[0]!.status, codes: sink.finish().map((d) => d.code), unmapped: r.unmapped };
  };

  it('link-checks a template-form url at import, whichever part spells the unsafe scheme', async () => {
    const dir = await caseDir('vc-url-template');
    const conv = await convertV5({ html: htmlOf(), htmlName: 'w.html', caseFolder: dir, caseId: 'vc' });
    for (const template of [['javascript:alert(1)', { param: 'x' }], [{ param: 'x' }, 'javascript:alert(1)'], ['data:text/html,', { param: 'x' }], ['java', { param: 'x' }, 'script:alert(1)']]) {
      const files = (await import('./fixtures/build.ts')).editPackage(conv.files!, 'datasets/view-content.json', (v) => { v.data.caselines_tab.url = { template }; });
      const r = await importCandidate({ files }, dir);
      expect(r.verdict, JSON.stringify(template)).toBe('reject');
      expect(r.diagnostics.some((d) => d.code === 'LINK_UNSAFE_SCHEME' && d.file === 'datasets/view-content.json'), JSON.stringify(template)).toBe(true);
    }
  });

  it('never returns an unsafe url from the reader, in string, list or template form, before or after filling', () => {
    const rd = readViewContent({ a: { url: 'javascript:alert(1)', link: ['./ok.pdf', 'data:text/html,x'], href: { template: ['javascript:', { param: 'x' }] }, file: { template: [{ param: 'u' }] }, folder: './INVENTED/', note: 'javascript:alert(1)' } });
    expect([rd.value('a', 'url'), rd.text('a', 'url'), rd.fill('a', 'url')]).toEqual([null, null, null]);
    expect([rd.value('a', 'link'), rd.list('a', 'link')]).toEqual([null, null]);
    expect([rd.value('a', 'href'), rd.params('a', 'href'), rd.fill('a', 'href', { x: 'alert(1)' })]).toEqual([null, null, null]);
    expect(rd.fill('a', 'file', { u: 'javascript:alert(1)' })).toBeNull();
    expect(rd.fill('a', 'file', { u: './INVENTED.pdf' })).toEqual({ text: './INVENTED.pdf', missing: [] });
    expect(rd.text('a', 'folder')).toBe('./INVENTED/');
    expect(rd.text('a', 'note')).toBe('javascript:alert(1)'); // not a link field: plain untrusted text
    expect(rd.fields('a')).toEqual(['file', 'folder', 'note']);
  });

  it('refuses every reserved private-use character (U+E000 to U+E004) in a pattern capture', () => {
    for (const cp of [0xe000, 0xe001, 0xe002, 0xe003, 0xe004]) {
      const r = one(`function exportICS(){let ics='PRODID:-//A${String.fromCharCode(cp)}B//EN';}`, { scope: 'function:exportICS', sel: { pattern: 'PRODID:-//([^/]+)//' }, kind: 'text' });
      expect([r.status, r.value], cp.toString(16)).toEqual(['shape', undefined]);
    }
    expect(one("function exportICS(){let ics='PRODID:-//AB//EN';}", { scope: 'function:exportICS', sel: { pattern: 'PRODID:-//([^/]+)//' }, kind: 'text' }).value).toBe('AB');
  });

  it('checks a template interpolation against its source expression exactly, not as a substring', () => {
    const tpl = (expr: string) => one(`RENDER.t=function(el){pageHead('T','From '+${expr}+' items');};`, { scope: 'render:t', sel: { call: 'pageHead', arg: 1 }, kind: 'template', params: [{ name: 'docCount', expect: 'META.docCount' }] });
    for (const expr of ['META.docCountOld', '(META.docCount*0)', "'META.docCount'", 'X.META.docCount', 'META.docCount.length']) expect(tpl(expr).status, expr).toBe('shape');
    expect(tpl('META.docCount').value).toEqual({ template: ['From ', { param: 'docCount' }, ' items'] });
    expect(tpl('META . docCount /* same tokens */').status).toBe('extracted');
  });

  it('reports a renderer defined again in a branch, loop or plain function as ambiguous; an IIFE redefinition stays live', () => {
    const sel = { scope: 'render:t' as const, sel: { call: 'pageHead', arg: 1 }, kind: 'text' as const };
    const live = "RENDER.t=function(el){pageHead('T','live');};";
    const dead = "RENDER.t=function(el){pageHead('T','dead');};";
    for (const wrap of [`if(false){${dead}}`, `if(x){}else{${dead}}`, `function never(){${dead}}`, `for(;false;){${dead}}`, `(function(){${dead}});`, `(function(){if(0){${dead}}})();`]) {
      for (const script of [live + wrap, wrap + live]) {
        const r = one(script, sel);
        expect([r.status, r.codes], script).toEqual(['ambiguous', ['V5_VIEW_CONTENT_AMBIGUOUS']]);
      }
    }
    const iife = "RENDER.t=function(el){pageHead('T','old');};";
    expect(one(iife + "(function(){RENDER.t=function(el){pageHead('T','live');};})();", sel).value).toBe('live');
    expect(one(iife + "(function(){RENDER.t=function(el){pageHead('T','live');};}());", sel).value).toBe('live');
    expect(one(iife + "(()=>{(function(){RENDER.t=function(el){pageHead('T','live');};})();})();", sel).value).toBe('live');
    // a single renderer must be proven live too (PR #8 review): one inside a branch is not
    expect(one("if(x){RENDER.t=function(el){pageHead('T','only');};}", sel)).toMatchObject({ value: undefined, status: 'missing', codes: ['V5_VIEW_CONTENT_MISSING'] });
  });

  it('flags invisible and zero-width characters in view content and reveals them, as in every dataset', async () => {
    const hidden = [0x034f, 0x115f, 0x180b, 0x206f, 0x3164, 0xfe0f, 0xfff9, 0x1d173, 0xe0001, 0xe0020, 0xe0100];
    for (const cp of hidden) expect(revealInvisible(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe(`a⟨U+${cp.toString(16).toUpperCase().padStart(4, '0')}⟩b`);
    expect(revealInvisible('plain é text, ©')).toBe('plain é text, ©');
    const dir = await caseDir('vc-hidden');
    const conv = await convertV5({ html: htmlOf(), htmlName: 'w.html', caseFolder: dir, caseId: 'vc' });
    const files = (await import('./fixtures/build.ts')).editPackage(conv.files!, 'datasets/view-content.json', (v) => { v.data.zz_hidden = Object.fromEntries(hidden.map((cp) => [`f${cp.toString(16)}`, `a${String.fromCodePoint(cp)}b`])); });
    const r = await importCandidate({ files }, dir);
    const flagged = r.diagnostics.filter((d) => d.code === 'TEXT_CONTROL_CHARS' && d.file === 'datasets/view-content.json').map((d) => d.pointer);
    expect(flagged.sort()).toEqual(hidden.map((cp) => `/data/zz_hidden/f${cp.toString(16)}`).sort());
  });

  describe('stays linear on the hostile shapes of the review lanes', () => {
    const title = { scope: 'markup' as const, sel: { html: 'title' }, kind: 'text' as const };
    const shapes: [string, () => unknown][] = [
      ['P1 \\u{ without a closing brace', () => one(`const S='${'\\u{'.repeat(400_000)}';`, title)],
      ['P2 an unterminated /* per script block', () => extractViewContent('<script>/*</script>'.repeat(120_000), [{ view: 'v', field: 'f', checklist: 'L1', required: false, ...title }], [])],
      ['P3 repeated unterminated const', () => one('const CAP='.repeat(40_000), { scope: 'const:CAP', sel: { lit: 'object', path: ['x'] }, kind: 'text' })],
      ['P4 unclosed comments in static markup', () => one('', title, { markup: '<!--'.repeat(80_000) })],
      ['P5 <script without a closing >', () => extractViewContent('<script '.repeat(64_000), [{ view: 'v', field: 'f', checklist: 'L1', required: false, ...title }], [])],
      ['P7 many script elements in element text', () => markupText('<script></script>'.repeat(80_000))],
      ['P8 unclosed comments in element text', () => markupText('<!--x'.repeat(80_000))],
      ['P9 an unclosed tag run in an unconsumed literal', () => one(`RENDER.t=function(el){let h='${'<a'.repeat(120_000)}>';};`, { scope: 'render:t', sel: { call: 'pageHead', arg: 1 }, kind: 'text' }, { audit: true })],
      ['P10 nested calls with callbacks', () => one(`RENDER.t=function(el){let h='<p>a</p>';${'f('.repeat(40_000)}1${',()=>1)'.repeat(40_000)};};`, { scope: 'render:t', sel: { html: 'p' }, kind: 'text' })],
      ['tags with an unclosed quote', () => markupText('<p "'.repeat(80_000))],
    ];
    for (const [label, run] of shapes) {
      it(label, () => {
        const t0 = performance.now();
        run();
        expect(performance.now() - t0).toBeLessThan(1000);
      }, 30_000);
    }
  });

  it('fails closed with a diagnostic past the size bound or the deadline', () => {
    const script = "RENDER.t=function(el){pageHead('T','value');};";
    const sel = { scope: 'render:t' as const, sel: { call: 'pageHead', arg: 1 }, kind: 'text' as const };
    expect(one(script, sel).value).toBe('value');
    for (const opts of [{ maxChars: 10 }, { deadlineMs: -1 }]) {
      const r = one(script, sel, opts);
      expect([r.value, r.status, r.codes], JSON.stringify(opts)).toEqual([undefined, 'missing', ['V5_VIEW_CONTENT_LIMIT']]);
    }
  });
});

describe('view-content dataset', () => {
  it('is a generated, optional, schema-validated dataset that reassembly ignores', async () => {
    const dir = await caseDir('vc-pkg');
    const conv = await convertV5({ html: htmlOf(), htmlName: 'w.html', caseFolder: dir, caseId: 'vc' });
    const r = await importCandidate({ files: conv.files! }, dir);
    expect(r.verdict).not.toBe('reject');
    const env = r.candidate!.dataset('view-content')!;
    expect([env.kind, env.schema, env.required, env.provenance.sourcePath]).toEqual(['generated', 'v5.view-content@1', false, '(view-code)']);
    expect(r.diagnostics.filter((d) => d.file === 'datasets/view-content.json')).toEqual([]);
    const back = reassembleV5(r.candidate!.datasetKeys().map((k) => r.candidate!.dataset(k)!));
    expect(Object.keys(back.DATA as object)).not.toContain('view-content');
    const bad = await importCandidate({ files: (await import('./fixtures/build.ts')).editPackage(conv.files!, 'datasets/view-content.json', (v) => { v.data.overview.subtitle = { nested: true }; }) }, dir);
    expect(bad.verdict).toBe('reject');
    expect(bad.diagnostics.some((d) => d.code === 'DS_SHAPE_INVALID' && d.file === 'datasets/view-content.json')).toBe(true);
  });

  it('changes only view-content and the manifest when code-embedded content changes', async () => {
    const dir = await caseDir('vc-identity');
    const a = await convertV5({ html: htmlOf(), htmlName: 'w.html', caseFolder: dir, caseId: 'vc' });
    const b = await convertV5({ html: htmlOf(swap('An invented counsel note.', 'An invented counsel notE.')), htmlName: 'w.html', caseFolder: dir, caseId: 'vc' });
    const differ = [...a.files!.keys()].filter((p) => sha256Hex(a.files!.get(p)!) !== sha256Hex(b.files!.get(p)!));
    expect(differ.sort()).toEqual(['datasets/view-content.json', 'manifest.json']);
    expect(b.manifest!.resultsVersion).not.toBe(a.manifest!.resultsVersion);
    expect(b.manifest!.inputRevision.id).not.toBe(a.manifest!.inputRevision.id);
  });

  it('is emitted, holding only static page markup, for HTML without viewer code', async () => {
    const dir = await caseDir('vc-empty');
    const conv = await convertV5({ html: htmlOf(false), htmlName: 'w.html', caseFolder: dir, caseId: 'vc' });
    expect(conv.ok).toBe(true);
    const r = await importCandidate({ files: conv.files! }, dir);
    expect(Object.keys(r.candidate!.dataset(VIEW_CONTENT.key)!.data as object)).toEqual([SHELL_VIEW]);
    expect(conv.viewContent!.fields.filter((f) => f.status !== 'missing').map((f) => f.field)).toEqual(['documentTitle']);
  });
});

describe('readViewContent', () => {
  const data = extract().data;
  const rd = readViewContent(data);
  it('reads typed values and fills templates from supplied params', () => {
    expect(rd.text('overview', 'subtitle')).toBe('Synthetic Holdings Ltd v Example Department');
    expect(rd.text('timeline', 'synopsis')).toBeNull();
    expect(rd.number('settlement_tab', 'defaultYears')).toBe(3);
    expect(rd.list('elements_tab', 'columns')).toEqual(['Element', 'What SYN must prove']);
    expect(rd.params('caselines_tab', 'heroNote')).toEqual(['pages']);
    expect(rd.fill('caselines_tab', 'heroNote', { pages: 12 })).toEqual({ text: 'Invented bundle · 12 pages (XX-001)', missing: [] });
    expect(rd.fill('invoice_ledger_tab', 'subtitle')).toEqual({ text: ' SYN-series invoices', missing: ['count'] });
    expect(rd.fill('overview', 'subtitle')).toEqual({ text: 'Synthetic Holdings Ltd v Example Department', missing: [] });
    expect(rd.views()).toContain(SHELL_VIEW);
    expect(rd.fields('settlement_tab')).toEqual(['defaultDiscountRate', 'defaultEnforcementCost', 'defaultProbability', 'defaultYears', 'narrative', 'subtitle']);
  });
  it('reads absent or malformed data as unavailable, never as a fallback literal', () => {
    for (const bad of [null, 'x', [], { overview: 'x' }, JSON.parse('{"__proto__":{"subtitle":"x"}}'), { overview: { subtitle: { nested: true } } }]) {
      const r = readViewContent(bad);
      expect(r.text('overview', 'subtitle')).toBeNull();
      expect(r.fill('overview', 'subtitle')).toBeNull();
    }
    expect(readViewContent(data).text('overview', 'constructor')).toBeNull();
    expect(readViewContent(data).text('toString', 'subtitle')).toBeNull();
  });
});

describe('view-content map', () => {
  it('covers 28 v5 views plus the shell with well-formed, unique ids and checklist references', () => {
    expect(() => checkMap(VIEW_CONTENT_MAP, VIEW_CONTENT_OMISSIONS)).not.toThrow();
    const views = new Set(VIEW_CONTENT_MAP.map((e) => e.view));
    for (const v of views) expect(v === SHELL_VIEW || (V5_VIEW_IDS as readonly string[]).includes(v)).toBe(true);
    expect(views.size).toBe(29);
    for (const e of [...VIEW_CONTENT_MAP, ...VIEW_CONTENT_OMISSIONS]) expect(e.checklist).toMatch(/S-[a-z_]+-\d+|L\d+/);
    for (const o of VIEW_CONTENT_OMISSIONS) expect(o.reason.length).toBeGreaterThan(10);
    expect(() => checkMap([...VIEW_CONTENT_MAP, VIEW_CONTENT_MAP[0]!], [])).toThrow(/duplicate/);
  });
});

describe('view-content extraction: export file names, CSV keys and the register introduction (BASE-R2)', () => {
  const diag = (r: ReturnType<typeof extract>) => r.diagnostics.map((d) => [d.code, d.subject]);
  it('extracts every export name, the Defence CSV keys and the register introduction from the synthetic code', () => {
    const { data, fields } = extract();
    expect(fields.filter((f) => f.status !== 'extracted')).toEqual([]);
    expect(data.chronology).toEqual({ exportFileName: 'syn-chronology.csv' });
    expect(data.search).toEqual({ exportFileName: 'syn-search.csv' });
    expect(data.contracts_tab!.exportFileName).toBe('syn-contracts.csv');
    expect(data.filings_tab!.exportFileName).toBe('syn-filings.csv');
    expect(data.filings_tab!.registerExportFileName).toBe('syn-filing-register.csv');
    expect(data.contradictions_tab!.exportFileName).toBe('syn-contradictions.csv');
    expect(data.vdm_matrix_tab!.exportFileName).toBe('syn-defence-matrix.csv');
    expect(data.vdm_matrix_tab!.exportColumns).toEqual(['syn_point', 'documents', 'syn_rebuttal', 'org_answer', 'status']);
  });

  it('extracts the export names of the quantum, register, litigation and system views, one entry per view for a shared export', () => {
    const { data } = extract();
    const names = Object.fromEntries(['quantum_tab', 'invoice_ledger_tab', 'prescription_tab', 'payments_tab', 'deadlines_tab', 'authorities_tab', 'heads_tab', 'rescan_tab', 'backup_tab']
      .map((v) => [v, data[v]?.exportFileName]));
    expect(names).toEqual({
      quantum_tab: 'syn-invoices.csv', invoice_ledger_tab: 'syn-invoices.csv', prescription_tab: 'syn-prescription.csv', payments_tab: 'syn-payments.csv', deadlines_tab: 'syn-deadlines.ics',
      authorities_tab: 'syn-authorities.csv', heads_tab: 'syn-heads.txt', rescan_tab: 'syn-index.json', backup_tab: 'syn-backup.json',
    });
    // the ICS and heads scopes keep their other anchors
    expect(data.deadlines_tab!.icsProductId).toBe('SYN v ORG');
    expect(data.heads_tab!.exportCaption).toBe('SYN v ORG');
    // a shared export function that is missing fails both views
    const gone = extract(swap('function exportInvoices(){', 'function exportBills(){'));
    expect(diag(gone).sort()).toEqual([['V5_VIEW_CONTENT_MISSING', 'invoice_ledger_tab.exportFileName'], ['V5_VIEW_CONTENT_MISSING', 'quantum_tab.exportFileName']]);
  });

  it('keeps only the introduction of the register paragraph, never the storage sentence or its key', () => {
    const intro = extract().data.filings_tab!.registerIntro;
    expect(intro).toBe('An invented register of the invented bundle, kept by hand.');
    expect(intro).not.toMatch(/browser|syn_register_v1/);
    // without the closing storage sentence there is no structural anchor: missing, not guessed
    const bare = extract(swap(' It is saved in this browser (syn_register_v1).</p>', '</p>'));
    expect(bare.data.filings_tab!.registerIntro).toBeUndefined();
    expect(diag(bare)).toEqual([['V5_VIEW_CONTENT_MISSING', 'filings_tab.registerIntro']]);
    // two paragraphs of that shape: ambiguous
    const two = extract(swap("h+='</div>';el.innerHTML=h;};", "h+='<p>Another invented paragraph. Kept in (syn_other).</p>';h+='</div>';el.innerHTML=h;};"));
    expect(two.data.filings_tab!.registerIntro).toBeUndefined();
    expect(diag(two)).toEqual([['V5_VIEW_CONTENT_AMBIGUOUS', 'filings_tab.registerIntro']]);
  });

  it('refuses a computed file name as a shape miss instead of guessing', () => {
    const r = extract(swap("dl('syn-chronology.csv',", "dl(caseKey+'.csv',"));
    expect(r.data.chronology).toBeUndefined();
    expect(diag(r)).toEqual([['V5_VIEW_CONTENT_MISSING', 'chronology.exportFileName']]);
    expect(r.fields.find((f) => f.view === 'chronology')!.status).toBe('shape');
    expect(r.diagnostics[0]!.message).toMatch(/expected literal text, found code/);
  });

  it('reports a missing export function, and one defined twice as ambiguous', () => {
    const gone = extract(swap('function exportSearch(){', 'function exportFind(){'));
    expect(gone.data.search).toBeUndefined();
    expect(diag(gone)).toEqual([['V5_VIEW_CONTENT_MISSING', 'search.exportFileName']]);
    expect(gone.diagnostics[0]!.message).toMatch(/scope function:exportSearch not found/);
    const twice = extract(swap("function exportFilings(){", "function exportContracts(){dl('syn-other.csv','','text/csv');}\nfunction exportFilings(){"));
    expect(twice.data.contracts_tab!.exportFileName).toBeUndefined();
    expect(diag(twice)).toEqual([['V5_VIEW_CONTENT_AMBIGUOUS', 'contracts_tab.exportFileName']]);
  });

  it('refuses a CSV header with a computed key', () => {
    const r = extract(swap("'org_answer','status'];", "'org_answer',DATA.matter.side+'_status'];"));
    expect(r.data.vdm_matrix_tab!.exportColumns).toBeUndefined();
    expect(r.data.vdm_matrix_tab!.exportFileName).toBe('syn-defence-matrix.csv');
    expect(diag(r)).toEqual([['V5_VIEW_CONTENT_MISSING', 'vdm_matrix_tab.exportColumns']]);
    expect(r.diagnostics[0]!.message).toMatch(/list item is code/);
  });
});

describe('view-content extraction: a renderer must be proven live (PR #8 review)', () => {
  const subtitle = entry('overview', 'subtitle')[0]!;
  const run = (script: string) => {
    const sink = new DiagSink();
    const r = extractViewContent(`<script>${script}</script>`, [subtitle], [], { sink });
    return { value: r.data.overview?.subtitle, status: r.fields[0]!.status, codes: sink.finish().map((d) => d.code) };
  };
  const LIVE = "RENDER.overview=function(el){pageHead('Overview','LIVE')};";
  const DEAD = "RENDER.overview=function(){pageHead('Overview','DEAD')};";
  const refused = (script: string, status: 'missing' | 'ambiguous') =>
    expect(run(script), script).toEqual({ value: undefined, status, codes: [status === 'missing' ? 'V5_VIEW_CONTENT_MISSING' : 'V5_VIEW_CONTENT_AMBIGUOUS'] });

  it('refuses a single renderer assigned inside a function that is never called (reviewer probe 1)', () => {
    refused(`function neverCalled(){ ${DEAD} }`, 'missing');
  });

  it('refuses a live renderer followed by an unbraced if(false) redefinition (reviewer probe 2)', () => {
    refused(`${LIVE}if(false) ${DEAD}`, 'ambiguous');
  });

  it('treats unbraced control flow, short circuits, ternaries, loops and dead code as conditional', () => {
    const dead = DEAD.slice(0, -1);
    const wraps = [
      `if(false) ${DEAD}`, `if(x);else ${DEAD}`, `if(x)\n${DEAD}`, `while(false) ${DEAD}`, `for(;false;) ${DEAD}`, `for(const k of []) ${DEAD}`,
      `do ${DEAD} while(false);`, `x && (${dead});`, `x || (${dead});`, `x ? ${dead} : 0;`, `x, ${DEAD}`, `l: ${DEAD}`,
      `if(false) (function(){${DEAD}})();`, `x && (function(){${DEAD}})();`, `(function(){return; ${DEAD}})();`, `(function(){if(x) return; ${DEAD}})();`,
      `throw 0; ${DEAD}`, `(function(){${DEAD}});`, `(function*(){${DEAD}})();`, `{ ${DEAD} }`, `try { ${DEAD} } catch (e) {}`,
      `${dead}?0:0;`, `${dead}(0);`, `${dead}&&f;`, `${dead}\n.call(0);`,
    ];
    for (const w of wraps) {
      refused(w, 'missing');
      refused(LIVE + w, 'ambiguous');
    }
  });

  it('refuses a redefinition after a braced early return in an immediately invoked function (PR #8 round 2 probe)', () => {
    const probe = 'RENDER.overview = function () { pageHead("Overview", "LIVE"); }; (function () { if (true) { return; } RENDER.overview = function () { pageHead("Overview", "DEAD"); }; })();';
    refused(probe, 'ambiguous');
    refused('(function () { if (true) { return; } RENDER.overview = function () { pageHead("Overview", "DEAD"); }; })();', 'missing');
  });

  it('propagates a return or throw in any nested block of the same function, however deep', () => {
    const wraps = [
      `(function(){try{return;}catch(e){}${DEAD}})();`, `(function(){try{f();}catch(e){return;}${DEAD}})();`, `(function(){try{f();}finally{return;}${DEAD}})();`,
      `(function(){switch(x){case 1:return;default:}${DEAD}})();`, `(function(){switch(x){case 1:{if(y){return;}}}${DEAD}})();`,
      `(function(){out:{if(x){return;}break out;}${DEAD}})();`, `(function(){for(;;){return;}${DEAD}})();`, `(function(){while(x){if(y){return;}}${DEAD}})();`,
      `(function(){do{return;}while(x);${DEAD}})();`, `(async function(){for await(const a of b){return;}${DEAD}})();`, `(function(){{return;}${DEAD}})();`,
      `(function(){if(x){}else{return;}${DEAD}})();`, `(function(){if(x){throw 0;}${DEAD}})();`, `(()=>{if(x){return;}${DEAD}})();`,
      `(function(){if(x){return;}(function(){${DEAD}})();})();`, `if(x){throw 0;}${DEAD}`,
    ];
    for (const w of wraps) {
      refused(w, 'missing');
      refused(LIVE + w, 'ambiguous');
    }
    // a labelled break only leaves its block; an assignment inside that block after it stays refused
    refused(`(function(){out:{if(true){break out;}${DEAD}}})();`, 'missing');
  });

  it('keeps a renderer after nested functions that return or throw, and after break or continue', () => {
    for (const s of [
      `(function(){function helper(){if(x){return 1;}return 2;}${LIVE}})();`, `(function(){var h=function(){try{return 1;}catch(e){throw e;}};${LIVE}})();`,
      `(function(){var h=()=>{if(x){return;}};${LIVE}})();`, `(function(){var o={m(){if(x){return;}},get g(){return 1;}};${LIVE}})();`,
      `(function(){[1].forEach(function(a){if(a){return;}});${LIVE}})();`, `if(x){f(function(){throw 0;});}${LIVE}`,
      `class C{m(){if(x){return;}}}${LIVE}`, `function helper(){for(const a of b){if(a){return a;}}}${LIVE}`,
      `(function(){out:{if(x){break out;}}for(const a of b){if(a){continue;}break;}${LIVE}})();`,
    ]) {
      expect(run(s), s).toEqual({ value: 'LIVE', status: 'extracted', codes: [] });
    }
  });

  it('refuses a function renderer that a later assignment replaces', () => {
    for (const w of ['RENDER.overview=other;', 'RENDER.overview=null;', 'RENDER.overview&&=other;', 'RENDER.overview||=other;']) expect(run(LIVE + w).value, w).toBeUndefined();
  });

  it('keeps renderers that provably run: top level, statement starts, and immediately invoked chains', () => {
    for (const s of [LIVE, `x();\n${LIVE}`, `if(x){}\n${LIVE}`, `if(x) y();${LIVE}`, `if(x);${LIVE}`, `;(function(){${LIVE}})();`, `(function(){var a=1;${LIVE}}());`,
      `(()=>{${LIVE}})();`, `(async function(){${LIVE}})();`, `(function(){(()=>{${LIVE}})();})();`, `${DEAD}(function(){${LIVE}})();`, `${DEAD}${LIVE}`,
      `(function(){function inner(){return 1;}${LIVE}})();`, `RENDER.overview=null;${LIVE}`]) {
      expect(run(s), s).toEqual({ value: 'LIVE', status: 'extracted', codes: [] });
    }
    // separate script blocks: the last block's top-level renderer is live
    const sink = new DiagSink();
    const r = extractViewContent(`<script>${DEAD}</script><script>${LIVE}</script>`, [subtitle], [], { sink });
    expect(r.data.overview?.subtitle).toBe('LIVE');
  });
});
