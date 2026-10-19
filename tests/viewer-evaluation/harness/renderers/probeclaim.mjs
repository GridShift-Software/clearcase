// Containment probe (test-only renderer): claims the port with a wrong nonce. The shell must refuse and send nothing.
const p = new URLSearchParams(location.hash.slice(1));
window.__r = { gotPort: false, gotBytes: false };
addEventListener('message', (e) => {
  if (e.data?.type !== 'port' || !e.ports[0]) return;
  window.__r.gotPort = true;
  e.ports[0].onmessage = (m) => { if (m.data?.bytes) window.__r.gotBytes = true; };
  e.ports[0].postMessage({ type: 'claim', nonce: 'not-the-nonce' });
});
parent.postMessage({ type: 'hello', g: Number(p.get('g')) }, '*');
