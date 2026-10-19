// The trusted broker. It alone fetches descriptors and bytes (with the session cookie), checks the bytes against the
// descriptor's SHA-256, and hands them to one opaque-origin renderer generation over a MessagePort. The port is
// released only after the renderer proves it is the document this generation loaded (a nonce in its own URL), and a
// second load of the same frame (a navigation) kills the generation, so a replacement document never gets bytes.
const host = document.getElementById('frame-host');
const statusEl = document.getElementById('shell-status');
const crumbs = document.getElementById('crumbs');
const closeBtn = document.getElementById('viewer-close');
const events = [];
let gen = 0;
let current = null;
const stack = [];

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const emit = (e) => { events.push({ t: Math.round(performance.now()), gen: current?.gen ?? null, ...e }); };

const FAMILIES = ['pdf', 'image', 'word', 'sheet', 'email', 'media', 'archive', 'text'];
/** Field names that are missing, null or retyped. Any one refuses the open before a frame exists. */
function invalidFields(d) {
  const bad = [];
  if (d?.schema !== 'clearcase.viewer-descriptor/1') bad.push('schema');
  if (typeof d?.assetId !== 'string' || !d.assetId) bad.push('assetId');
  if (typeof d?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(d.sha256)) bad.push('sha256');
  if (!FAMILIES.includes(d?.family)) bad.push('family');
  if (!Array.isArray(d?.children)) bad.push('children');
  if (!Array.isArray(d?.holds)) bad.push('holds');
  return bad;
}

async function fetchAsset(id) {
  const [dr, br] = await Promise.all([fetch(`/descriptor/${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store' }), fetch(`/asset/${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store' })]);
  if (!dr.ok || !br.ok) throw new Error(`asset ${id} unavailable (${dr.status}/${br.status})`);
  const descriptor = await dr.json();
  const bad = invalidFields(descriptor);
  if (bad.length) throw new Error(`descriptor: ${id} has missing, null or retyped ${bad.join(', ')}`);
  const bytes = await br.arrayBuffer();
  const digest = hex(await crypto.subtle.digest('SHA-256', bytes));
  if (digest !== descriptor.sha256) throw new Error(`integrity: ${id} bytes hash ${digest}, descriptor says ${descriptor.sha256}`);
  return { descriptor, bytes };
}

function kill(reason) {
  if (!current) return;
  emit({ type: 'killed', reason });
  current.port?.close();
  current.frame.remove();
  current = null;
}

function renderCrumbs() {
  crumbs.replaceChildren(...stack.map((s, i) => { const li = document.createElement('li'); li.textContent = s.label; if (i === stack.length - 1) li.setAttribute('aria-current', 'page'); return li; }));
}

/** Open an asset (and any extra assets it needs, such as rendition page images) with an optional citation target. */
async function open(id, target = { kind: 'file' }, opts = {}) {
  kill('replaced');
  const g = ++gen;
  const t0 = performance.now();
  let main, extras = [];
  try {
    main = await fetchAsset(id);
    for (const x of opts.extra ?? []) extras.push({ id: x, ...(await fetchAsset(x)) });
  } catch (err) {
    emit({ type: 'shell-error', message: String(err.message ?? err) });
    statusEl.textContent = `Cannot open: ${err.message ?? err}`;
    return { ok: false, error: String(err.message ?? err) };
  }
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; payment 'none'; usb 'none'");
  frame.title = `${main.descriptor.name} (${main.descriptor.family} reader)`;
  frame.className = 'viewer-frame';
  const family = opts.family ?? main.descriptor.family;
  const gen_ = { gen: g, frame, nonce, port: null, loads: 0, descriptor: main.descriptor, claimed: false };
  current = gen_;
  if (!opts.keepStack) stack.length = 0;
  stack.push({ id, label: main.descriptor.name });
  renderCrumbs();
  frame.addEventListener('load', () => { gen_.loads++; if (gen_.loads > 1 && current === gen_) kill('renderer-navigated'); });
  const ready = new Promise((resolve) => { gen_.resolveReady = resolve; });
  const onHello = (e) => {
    if (current !== gen_ || e.source !== frame.contentWindow || e.data?.type !== 'hello' || e.data.g !== g || gen_.port) return;
    const { port1, port2 } = new MessageChannel();
    gen_.port = port1;
    port1.onmessage = (m) => {
      if (current !== gen_) return;
      const d = m.data ?? {};
      if (!gen_.claimed) {
        if (d.type === 'claim' && d.nonce === nonce && gen_.loads === 1) {
          gen_.claimed = true;
          emit({ type: 'claimed' });
          const transfer = [main.bytes, ...extras.map((x) => x.bytes)];
          port1.postMessage({ type: 'open', descriptor: main.descriptor, bytes: main.bytes, extras: extras.map((x) => ({ descriptor: x.descriptor, bytes: x.bytes })), target, options: opts.adapterOptions ?? {} }, transfer);
        } else { emit({ type: 'claim-rejected', got: d.type }); kill('bad-claim'); }
        return;
      }
      emit({ ...d, type: `renderer:${d.type}` });
      if (d.type === 'ready' || d.type === 'error') { statusEl.textContent = d.type === 'ready' ? '' : `Preview failed: ${d.code}`; gen_.resolveReady({ ...d, ms: Math.round(performance.now() - t0) }); }
      if (d.type === 'escape') closeBtn.focus();
      if (d.type === 'open-child') openChild(d.key);
    };
    frame.contentWindow.postMessage({ type: 'port', g }, '*', [port2]);
  };
  window.addEventListener('message', onHello);
  frame.src = `/r/${family}.html#g=${g}&n=${nonce}`;
  host.replaceChildren(frame);
  const r = await Promise.race([ready, new Promise((res) => setTimeout(() => res({ type: 'timeout', ms: 30000 }), opts.timeoutMs ?? 30000))]);
  window.removeEventListener('message', onHello);
  return r;
}

/** Contained files open by the child list the trusted descriptor carries, never by a renderer-supplied id or bytes. */
function openChild(key) {
  const d = current?.descriptor;
  const child = d?.children?.find((c) => c.key === String(key));
  if (!child?.assetId) { emit({ type: 'child-refused', key }); return; }
  emit({ type: 'child-open', key, assetId: child.assetId });
  open(child.assetId, { kind: 'file' }, { keepStack: true });
}

function navigate(target) {
  if (!current?.port) return Promise.resolve({ type: 'error', code: 'no-renderer' });
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const prev = current.port.onmessage;
    const port = current.port;
    port.onmessage = (m) => { if (m.data?.type === 'navigated' && m.data.id === id) { port.onmessage = prev; emit({ type: 'renderer:navigated', ...m.data }); resolve(m.data); } else prev(m); };
    port.postMessage({ type: 'navigate', target, id });
    setTimeout(() => { if (port.onmessage !== prev) { port.onmessage = prev; resolve({ type: 'navigated', id, resolution: { ok: false, code: 'navigation-timeout', detail: 'no answer within 20 s', repair: true } }); } }, 20000);
  });
}

closeBtn.addEventListener('click', () => { kill('closed'); stack.length = 0; renderCrumbs(); });
window.__shell = { open, navigate, events, current: () => current && { gen: current.gen, loads: current.loads, claimed: current.claimed, family: current.descriptor.family } };
document.body.dataset.shell = 'ready';
