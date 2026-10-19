// CC-25 (GRS-24) acceptance items 3 and 5 on the real exports, through the app. The three packages the GRS-22 probe
// wrote are imported into a disposable data directory (<out>/data); v5 and the newer export as two versions of one
// case. Then:
//   - switch: a note on every document whose ref both versions use, written on v5, read back on the newer version
//     before and after activating it and after rolling back; a note may follow its ref only when that ref names the
//     same original (fingerprint), never otherwise;
//   - render: every registry view, the import report and a spread of document pages of each generation, server
//     rendered by the app's own routes (SvelteKit in a Vite dev server, as src/lib/local-case/ssr-pages.test.ts),
//     checked for markup the data could have made active: event-handler attributes, unsafe link and resource
//     schemes, embedding elements, and a script count that differs between generations on the same route.
// Prints and writes counts, route ids, codes and states only; note bodies are invented.
//
//   bun tests/acceptance/CC-25/real/render.ts --out DIR --v5 PKG=CASE --newer PKG=CASE --json PKG=CASE
//
// Exit 0 when every check holds, 1 otherwise.
import { createServer as httpServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import { isSafeAppHref } from '../../../../src/lib/case-package/render.ts';
import { VIEWS } from '../../../../src/lib/components/view-registry.ts';

type J = Record<string, any>;
const REPO = path.resolve(import.meta.dirname, '../../../..');
const { values: a } = parseArgs({ options: { out: { type: 'string' }, v5: { type: 'string' }, newer: { type: 'string' }, json: { type: 'string' }, docs: { type: 'string', default: '120' } } });
if (!a.out || !a.v5 || !a.newer || !a.json) { console.error('usage: render.ts --out DIR --v5 PKG=CASE --newer PKG=CASE --json PKG=CASE [--docs N]'); process.exit(2); }
const split = (s: string) => { const [pkg, caseFolder] = s.split('='); return { pkg: path.resolve(pkg!), caseFolder: caseFolder! }; };
const input = { v5: split(a.v5), newer: split(a.newer), json: split(a.json) };
const problems: string[] = [];
const out: J = {};
const freePort = () => new Promise<number>((resolve) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
const tally = (xs: Iterable<string>) => { const c: Record<string, number> = {}; for (const x of xs) c[x] = (c[x] ?? 0) + 1; return Object.fromEntries(Object.entries(c).sort()); };

const [port, originalsPort] = [await freePort(), await freePort()];
Object.assign(process.env, { CLEARCASE_DATA_DIR: path.join(path.resolve(a.out), 'data'), PORT: String(port), ORIGINALS_PORT: String(originalsPort), CLEARCASE_USERWORK_BACKUP_DELAY_MS: '600000' });
const vite = await createServer({ root: REPO, configFile: path.join(REPO, 'vite.config.ts'), logLevel: 'silent', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
const http = httpServer(vite.middlewares);
await new Promise<void>((r) => http.listen(port, '127.0.0.1', r));
const origin = `http://127.0.0.1:${port}`;
const originals = `http://clearcase-originals.localhost:${originalsPort}`;
let exit = 1;
try {
  if ((await fetch(`${origin}/api/health`)).status !== 200) throw new Error('the app did not start');
  const lc = ((await vite.ssrLoadModule('/src/lib/local-case/app.server.ts')) as { app: () => any }).app();
  const ack = (importId: number) => {
    const r = JSON.parse(lc.store.getImport(importId).report);
    const trusted: Set<string> = lc.trustedFor(r.caseId);
    return { resultsVersion: r.resultsVersion, manifestSha256: r.manifestSha256, diagnosticsSha256: r.diagnosticsSha256, validatorVersion: r.validatorVersion, warningFingerprints: r.warningFingerprints.filter((f: string) => !trusted.has(f)) };
  };
  const imported: Record<string, { vid: string; importId: number; caseId: string }> = {};
  for (const g of ['v5', 'newer', 'json'] as const) {
    const t0 = performance.now();
    const r = await lc.importPackage(input[g].caseFolder, input[g].pkg);
    if (r.kind !== 'stored') throw new Error(`${g}: import ${r.kind}`);
    const rep = JSON.parse(lc.store.getImport(r.importId).report);
    imported[g] = { vid: rep.resultsVersion, importId: r.importId, caseId: rep.caseId };
    out[`import-${g}`] = { verdict: rep.verdict, ms: Math.round(performance.now() - t0), errors: rep.diagnostics.filter((d: J) => d.severity === 'error').length };
  }
  const { v5, newer, json } = imported as Record<'v5' | 'newer' | 'json', { vid: string; importId: number; caseId: string }>;
  if (v5.caseId !== newer.caseId) throw new Error('v5 and the newer export must be two versions of one case');
  for (const x of [v5, json]) { const refused = await lc.activate(x.vid, ack(x.importId)); if (refused) throw new Error(`activation refused: ${refused.message}`); }

  // switch: one note per shared ref, written on v5
  const fps = (vid: string) => new Map<string, string>(lc.store.fingerprints(vid).map((f: { ref: string; sha256: string }) => [f.ref, f.sha256]));
  const before = fps(v5.vid), after = fps(newer.vid);
  const shared = [...before.keys()].filter((r) => after.has(r)).sort();
  const notes: { id: string; ref: string; same: boolean }[] = [];
  for (const [i, ref] of shared.entries()) notes.push({ id: (await lc.userWork.addNote(v5.caseId, v5.vid, ref, `CC-25 synthetic note ${i}`)).id, ref, same: before.get(ref) === after.get(ref) });
  const onNewer = (stage: string) => {
    const shown = new Map<string, Set<string>>();
    for (const ref of shared) shown.set(ref, new Set(lc.userWork.notesFor(v5.caseId, newer.vid, ref).map((n: { id: string }) => n.id)));
    const followed = notes.filter((n) => !n.same && shown.get(n.ref)!.has(n.id)).length;
    const keptSame = notes.filter((n) => n.same && shown.get(n.ref)!.has(n.id)).length;
    const status = (same: boolean) => tally(notes.filter((n) => n.same === same).map((n) => lc.userWork.resolve({ caseId: v5.caseId, sha256: before.get(n.ref)!, refAtCreation: n.ref, resultsVersion: v5.vid }, newer.vid).status));
    if (followed) problems.push(`${stage}: ${followed} notes shown on a reused ref that names another original`);
    if (keptSame !== notes.filter((n) => n.same).length) problems.push(`${stage}: ${notes.filter((n) => n.same).length - keptSame} notes lost on a ref that kept its original`);
    return { sameOriginal: notes.filter((n) => n.same).length, changedOriginal: notes.filter((n) => !n.same).length, shownOnSameRef: keptSame, followedTheRef: followed, changedStatus: status(false), sameStatus: status(true) };
  };
  out.switch = { sharedRefs: shared.length, notes: notes.length, preview: onNewer('preview') };
  const refused = await lc.activate(newer.vid, ack(newer.importId));
  if (refused) throw new Error(`activation of the newer version refused: ${refused.message}`);
  out.switch.active = onNewer('active');
  if (await lc.rollback(v5.caseId, newer.vid, v5.vid)) throw new Error('rollback refused');
  const back = tally(shared.map((ref) => lc.userWork.notesFor(v5.caseId, v5.vid, ref).filter((n: { status: string }) => n.status === 'here').length === 1 ? 'here' : 'not here'));
  out.switch.rolledBack = { active: lc.currentActive()?.vid === v5.vid, notes: back };
  if (back['not here']) problems.push(`after rollback ${back['not here']} notes are not on their own document`);

  // render: every view, the import report and a spread of document pages of each generation
  const scripts: Record<string, Record<string, number>> = {};
  for (const [g, x] of Object.entries(imported)) {
    const v = `/v/${encodeURIComponent(x.vid)}`;
    const refs = (JSON.parse(lc.store.chronologyJson(x.vid)) as J[]).map((r) => r.ref as string);
    const step = Math.max(1, Math.floor(refs.length / Number(a.docs)));
    const docs = refs.filter((_, i) => i % step === 0).slice(0, Number(a.docs));
    const routes: [string, string][] = [...VIEWS.map((w) => [w.id, `${v}${w.route}`] as [string, string]), ['import-report', `/import/${x.importId}`], ...docs.map((ref, i) => [`doc#${i}`, `${v}/doc/${encodeURIComponent(ref)}`] as [string, string])];
    const r: J = { pages: 0, status: {}, unsafe: [] as string[], handlers: 0, embeds: 0, externalWithoutRel: 0, ready: 0, bytes: 0, ms: 0 };
    const t0 = performance.now();
    for (const [id, p] of routes) {
      const res = await fetch(`${origin}${p}`);
      const body = await res.text();
      r.pages++; r.bytes += body.length;
      r.status[res.status] = (r.status[res.status] ?? 0) + 1;
      if (res.status !== 200) { problems.push(`${g} ${id}: status ${res.status}`); continue; }
      if (/<main[^>]*\sdata-ready=/.test(body)) r.ready++;
      let nScripts = 0;
      for (const m of body.matchAll(/<([a-zA-Z][\w:-]*)((?:\s[^<>]*)?)>/g)) {
        const tag = m[1]!.toLowerCase(), attrs = m[2] ?? '';
        if (tag === 'script') nScripts++;
        if (/\son[a-z]+\s*=/i.test(attrs)) { r.handlers++; problems.push(`${g} ${id}: <${tag}> carries an event-handler attribute`); }
        if (['object', 'embed', 'base', 'frame', 'frameset', 'applet'].includes(tag) || (tag === 'meta' && /http-equiv\s*=\s*["']?refresh/i.test(attrs))) { r.embeds++; problems.push(`${g} ${id}: <${tag}>`); }
        for (const u of attrs.matchAll(/\s(href|src|action|formaction|xlink:href|poster|data|srcdoc)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
          const name = u[1]!.toLowerCase();
          const value = (u[2] ?? u[3] ?? u[4] ?? '').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
          // relative locators (the app's own `?/action` forms and `./` assets) are resolved against the page first
          const at = URL.canParse(value, `${origin}${p}`) ? new URL(value, `${origin}${p}`) : null;
          const ok = name === 'srcdoc' || !at ? false
            : at.origin === origin ? (tag === 'script' || tag === 'link' ? true : isSafeAppHref(at.pathname))
            : at.origin === originals ? true
            : tag === 'a' && (at.protocol === 'https:' || at.protocol === 'mailto:') ? (at.protocol === 'mailto:' || (/\brel\s*=\s*["'][^"']*noopener[^"']*["']/i.test(attrs) && /noreferrer/i.test(attrs)) || (r.externalWithoutRel++, false))
            : false;
          if (!ok) { r.unsafe.push(`${id} <${tag} ${name}> ${(/^[a-z][a-z0-9+.-]*:/i.exec(value)?.[0] ?? value.slice(0, 1)) || 'empty'}`); problems.push(`${g} ${id}: unsafe <${tag} ${name}>`); }
        }
      }
      if (!id.startsWith('doc#')) (scripts[id] ??= {})[g] = nScripts;
      if (id === 'import-report') {
        // what the validation report tells the operator about data kept but not presented: every converter note outside the text-cap section must be on the page (GRS-24 F1)
        const files: Map<string, Uint8Array> = lc.store.packageFiles(x.vid);
        const read = (f: string) => JSON.parse(new TextDecoder().decode(files.get(f)!));
        const residual = (read('manifest.json').files as J[]).filter((f) => f.schema === 'opaque@1').map((f) => f.key as string);
        const conv = (read('datasets/conversion-report.json').data.diagnostics as J[]).filter((d) => d.code !== 'V5_TEXT_CAPPED');
        const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        r.residualOnReport = { datasets: residual.length, namedOnPage: residual.filter((k) => body.includes(k)).length, converterCoverage: conv.length, converterCoverageOnPage: conv.filter((d) => body.includes(esc(d.message)) || body.includes(d.message)).length };
        if (r.residualOnReport.converterCoverageOnPage !== r.residualOnReport.converterCoverage) problems.push(`${g} import-report: ${r.residualOnReport.converterCoverage - r.residualOnReport.converterCoverageOnPage} of ${r.residualOnReport.converterCoverage} converter coverage notes are not on the page`);
      }
    }
    r.ms = Math.round(performance.now() - t0);
    out[`render-${g}`] = r;
  }
  // a route's own scripts never depend on the case's data
  const differing = Object.entries(scripts).filter(([, c]) => new Set(Object.values(c)).size > 1).map(([id, c]) => `${id} ${JSON.stringify(c)}`);
  out.scriptCountsDiffer = differing;
  for (const d of differing) problems.push(`script count differs by generation: ${d}`);
  out.problems = problems;
  exit = problems.length ? 1 : 0;
  lc.shutdown();
} catch (e) {
  problems.push(`aborted: ${(e as Error).message}`);
  out.problems = problems;
} finally {
  await new Promise((r) => http.close(r));
  await vite.close();
  const g = globalThis as { __clearcase?: { originals?: { close(): void } } };
  g.__clearcase?.originals?.close();
}
await Bun.write(path.join(path.resolve(a.out), 'render.json'), JSON.stringify(out, null, 1));
console.log(problems.length ? `RENDER FAIL ${problems.length}: ${problems.slice(0, 8).join('; ')}${problems.length > 8 ? '; …' : ''}` : `RENDER PASS ${Object.keys(out).filter((k) => k.startsWith('render-')).map((k) => `${k.slice(7)} ${out[k].pages} pages`).join(', ')}; ${out.switch.notes} notes across the switch, none followed a reused ref`);
process.exit(exit);
