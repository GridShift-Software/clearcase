// Containment probe (test-only page): the document a navigated renderer frame ends up on. It knows the generation
// number but not the nonce, says hello and tries to claim. It must never receive a port with bytes.
const g = Number(new URLSearchParams(location.hash.slice(1)).get('g'));
window.__r = { attacker: true, gotPort: false, gotBytes: false };
addEventListener('message', (e) => {
  if (!e.ports[0]) return;
  window.__r.gotPort = true;
  e.ports[0].onmessage = (m) => { if (m.data?.bytes) window.__r.gotBytes = true; };
  e.ports[0].postMessage({ type: 'claim', nonce: 'guess' });
});
parent.postMessage({ type: 'hello', g }, '*');
