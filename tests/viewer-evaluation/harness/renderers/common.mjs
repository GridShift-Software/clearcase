// Renderer side of the broker protocol, shared by every family: say hello to the parent, claim the port with the nonce
// from this document's own URL, receive bytes, report ready/error, answer navigate requests, and record every CSP
// violation (attempted egress by document content) into the published state.
export const app = document.getElementById('app');
export const statusEl = document.getElementById('status');
export const state = (window.__r = { family: null, ready: false, error: null, blocked: [], resolution: null });
const params = new URLSearchParams(location.hash.slice(1));
let port = null;

document.addEventListener('securitypolicyviolation', (e) => { state.blocked.push({ directive: e.effectiveDirective, uri: String(e.blockedURI).slice(0, 120) }); publish(); });
export function publish() { try { document.body.dataset.state = JSON.stringify(state); } catch {} }
export function send(msg, transfer) { port?.postMessage(msg, transfer ?? []); }

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}

export const fail = (code, detail, repair = false) => ({ ok: false, code, detail, repair });
export const okRes = (label, extra = {}) => ({ ok: true, label, ...extra });

/** Rendition and file-level targets every paginated adapter resolves the same way. Never clamps, never guesses. */
export function resolvePaged(descriptor, target, numPages) {
  const inRange = (p) => Number.isInteger(p) && p >= 1 && p <= numPages;
  if (!target || target.kind === 'file') return okRes('File-level reference: no precise location supplied', { page: 1, fileLevel: true });
  if (target.kind === 'rendition-page') {
    if (descriptor.role !== 'rendition') return fail('not-a-rendition', 'a rendition page was cited on an original', true);
    if (target.version !== descriptor.rendition.version) return fail('stale-rendition', `cited processed preview v${target.version}, current is v${descriptor.rendition.version}`, true);
    if (!inRange(target.page)) return fail('invalid-target', `processed preview page ${target.page} does not exist (1-${numPages})`, true);
    return okRes(`Processed preview v${descriptor.rendition.version}, page ${target.page} of ${numPages} (generated pagination, not original pages)`, { page: target.page });
  }
  if (target.kind === 'original-page') {
    if (descriptor.role === 'rendition') {
      const map = descriptor.rendition.mapping;
      const mapped = map?.kind === 'verified' ? map.pages?.[String(target.page)] : undefined;
      if (!mapped) return fail('unmapped-original-location', `original page ${target.page} has no verified mapping to this processed preview`, true);
      if (!inRange(mapped)) return fail('invalid-target', `mapping points at missing preview page ${mapped}`, true);
      return okRes(`Original page ${target.page}, shown as processed preview v${descriptor.rendition.version} page ${mapped}`, { page: mapped });
    }
    if (!inRange(target.page)) return fail('invalid-target', `page ${target.page} does not exist (1-${numPages})`, true);
    return okRes(`Page ${target.page} of ${numPages}`, { page: target.page });
  }
  return fail('unsupported-target', `target kind ${target.kind} does not apply to this file`, true);
}

/** Boot one renderer: handlers.open(descriptor, bytes, extras, target, options) returns { navigate(target) }. */
export function boot(family, handlers) {
  state.family = family;
  publish();
  let adapter = null;
  addEventListener('keydown', (e) => { if (e.key === 'Escape') send({ type: 'escape' }); });
  addEventListener('message', (e) => {
    if (e.source !== parent || e.data?.type !== 'port' || port || !e.ports[0]) return;
    port = e.ports[0];
    port.onmessage = async (m) => {
      const d = m.data ?? {};
      if (d.type === 'open') {
        const t0 = performance.now();
        try {
          const extras = (d.extras ?? []).map((x) => ({ descriptor: x.descriptor, bytes: new Uint8Array(x.bytes) }));
          adapter = await handlers.open(d.descriptor, new Uint8Array(d.bytes), extras, d.target, d.options ?? {});
          const res = adapter.navigate ? await adapter.navigate(d.target) : okRes('opened');
          state.resolution = res;
          state.ready = true;
          state.readyMs = Math.round(performance.now() - t0);
          statusEl.textContent = res.ok ? res.label : `Reference needs repair: ${res.detail}`;
          publish();
          send({ type: 'ready', resolution: res, readyMs: state.readyMs });
        } catch (err) {
          state.error = { code: err.code ?? 'render-failed', message: String(err.message ?? err).slice(0, 300) };
          statusEl.textContent = `This preview failed (${state.error.code}): ${state.error.message}`;
          publish();
          send({ type: 'error', ...state.error });
        }
      } else if (d.type === 'navigate') {
        let res;
        try { res = adapter?.navigate ? await adapter.navigate(d.target) : fail('not-ready', 'no document'); } catch (err) { res = fail('navigation-failed', String(err.message ?? err).slice(0, 200), true); }
        state.resolution = res;
        statusEl.textContent = res.ok ? res.label : `Reference needs repair: ${res.detail}`;
        publish();
        send({ type: 'navigated', id: d.id, resolution: res });
      }
    };
    port.postMessage({ type: 'claim', nonce: params.get('n') });
  });
  parent.postMessage({ type: 'hello', g: Number(params.get('g')) }, '*');
}

export class RenderError extends Error { constructor(code, message) { super(message); this.code = code; } }
