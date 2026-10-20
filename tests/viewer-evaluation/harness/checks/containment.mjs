import { opens, sleep } from './common.mjs';

const F = 'containment';
const C = 'protected shell (opaque sandbox + CSP + port/nonce broker)';

export default async function containment(c, { full }) {
  if (!full) return;
  const id = 'pdf/text-basic.pdf';
  await opens(c, F, id, C);
  const n0 = c.serverLog.length;
  const probe = await c.inFrame(async (origin) => {
    const out = {};
    try { out.cookie = document.cookie; } catch (e) { out.cookie = `throws ${e.name}`; }
    try { out.storage = typeof localStorage.length; } catch (e) { out.storage = `throws ${e.name}`; }
    try { const r = await fetch(`${origin}/asset/pdf%2Ftext-basic.pdf`, { credentials: 'include' }); out.fetch = `status ${r.status}`; } catch (e) { out.fetch = `rejected ${e.name}`; }
    try { const r = await fetch(`${origin}/vendor/pdfjs/cmaps/../../../asset/pdf%2Ftext-basic.pdf`); out.pathTrick = `status ${r.status}`; } catch (e) { out.pathTrick = `rejected ${e.name}`; }
    try { top.location.href = `${origin}/shell.html?hijacked`; out.topNav = 'no exception'; } catch (e) { out.topNav = `throws ${e.name}`; }
    out.popup = String(window.open(`${origin}/shell.html?popup`) === null);
    try { parent.document.title; out.parentDom = 'readable'; } catch (e) { out.parentDom = `throws ${e.name}`; }
    out.origin = self.origin;
    return out;
  }, c.origin);
  await sleep(300);
  const assetHits = c.serverLog.slice(n0).filter((l) => l.path.startsWith('/asset/'));
  c.record(F, id, C, 'renderer runs in an opaque origin', probe.origin === 'null', "self.origin === 'null'", probe.origin);
  c.record(F, id, C, 'renderer cannot read cookies or storage', /^throws/.test(probe.cookie) && /^throws/.test(probe.storage), 'document.cookie and localStorage throw', probe);
  c.record(F, id, C, 'renderer cannot fetch case assets (even with credentials:include)', /^rejected/.test(probe.fetch) && /^rejected|status 4/.test(probe.pathTrick) && assetHits.every((l) => !l.authed), 'fetch rejected by CSP; no authorized /asset/ request reached the server', { fetch: probe.fetch, pathTrick: probe.pathTrick, assetHits });
  c.record(F, id, C, 'renderer cannot navigate the top window, open popups or read the parent DOM', /^throws/.test(probe.topNav) && probe.popup === 'true' && /^throws/.test(probe.parentDom) && !c.mon.topNavigations.length && !c.mon.popups.length, 'top navigation throws; window.open returns null; parent DOM access throws', probe);

  // forged hello from a window that is not the current renderer
  const before = await c.page.evaluate(() => window.__shell.events.length);
  await c.page.evaluate(() => window.postMessage({ type: 'hello', g: window.__shell.current().gen }, '*'));
  await sleep(200);
  const forged = await c.page.evaluate((n) => window.__shell.events.slice(n), before);
  c.record(F, id, C, 'forged hello from another window is ignored', forged.length === 0, 'no shell events after a hello whose source is not the renderer frame', forged);

  // wrong nonce
  const r1 = await c.open(id, { kind: 'file' }, { family: 'probeclaim', timeoutMs: 3000 });
  await sleep(300);
  const ev1 = await c.page.evaluate(() => window.__shell.events.slice(-3));
  c.record(F, id, C, 'a claim with the wrong nonce gets no bytes and kills the generation', r1.type === 'timeout' && ev1.some((e) => e.type === 'claim-rejected') && ev1.some((e) => e.type === 'killed' && e.reason === 'bad-claim'), "events claim-rejected + killed(bad-claim); open() never ready", ev1);

  // navigation between port hand-off and claim
  const r2 = await c.open(id, { kind: 'file' }, { family: 'probenav', timeoutMs: 3000 });
  await sleep(500);
  const ev2 = await c.page.evaluate(() => window.__shell.events.slice(-4));
  const att = await (async () => { const f = c.page.frames().find((x) => /attacker\.html/.test(x.url())); return f ? f.evaluate(() => window.__r).catch(() => 'frame gone') : 'frame removed by shell'; })();
  c.record(F, id, C, 'renderer navigated before claiming: replacement document gets no bytes', r2.type === 'timeout' && ev2.some((e) => e.type === 'killed' && e.reason === 'renderer-navigated') && (typeof att === 'string' || att.gotBytes === false), "events include killed(renderer-navigated); attacker page never receives bytes", { events: ev2, attacker: att });

  // integrity: descriptor hash mismatch
  const bad = c.alias(id, `${id}@wrong-hash`, { sha256: '0'.repeat(64) });
  const r3 = await c.open(bad);
  c.record(F, bad, C, 'bytes whose hash differs from the descriptor are never handed to a renderer', r3.ok === false && /integrity/.test(r3.error), 'shell refuses with an integrity error before creating a frame', r3);

  // fail closed on a missing, null or retyped descriptor field (REVIEW.md)
  const sha = c.descriptors.get(id).sha256;
  const mutations = [['schema', undefined], ['schema', 'clearcase.viewer-descriptor/0'], ['assetId', undefined], ['assetId', 7], ['sha256', undefined], ['sha256', null], ['sha256', 12345], ['sha256', sha.toUpperCase()], ['family', undefined], ['family', null], ['family', 'PDF'], ['children', undefined], ['children', {}], ['holds', null]];
  const outcomes = [];
  for (const [field, value] of mutations) {
    const mid = c.alias(id, `${id}@${field}-${String(value)}`, { [field]: value });
    const rr = await c.open(mid);
    outcomes.push({ field, value: value === undefined ? 'deleted' : value, ok: rr.ok, error: rr.error?.slice(0, 60) ?? rr.type });
  }
  c.record(F, id, C, 'a descriptor with a deleted, null or retyped field is refused before a frame exists', outcomes.every((o) => o.ok === false && /^(descriptor|integrity):/.test(o.error ?? '')), `${mutations.length} mutations of schema, assetId, sha256, family, children, holds: every open refused by the shell`, outcomes);
}
