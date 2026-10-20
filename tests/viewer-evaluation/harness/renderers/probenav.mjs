// Containment probe (test-only renderer): says hello, receives the port, then navigates itself to attacker.html
// before claiming, as a compromised or redirected renderer would. The shell must never send bytes after that.
const p = new URLSearchParams(location.hash.slice(1));
addEventListener('message', (e) => { if (e.data?.type === 'port') location.href = new URL(`attacker.html#g=${p.get('g')}`, location.href).href; });
parent.postMessage({ type: 'hello', g: Number(p.get('g')) }, '*');
