// In-page colour helpers of scripts/verify/layout.mjs, as page source (kept apart so tests/gate can run them).
/** Colour helpers as page source: parse rgb(a), composite on the effective background, WCAG relative luminance and ratio. */
export const COLOR = `
	const rgba = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s || ''); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
	const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
	// a gradient is the effective background of its element: against the text colour, its worst opaque stop (the computed background-color under it is not what is painted)
	const stops = (img) => (img || '').includes('gradient') ? [...img.matchAll(/rgba?\\([^)]+\\)/g)].map((m) => rgba(m[0])).filter((c) => c && c.a >= 1) : [];
	const bgOf = (el, fg) => { const layers = []; for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); const g = stops(cs.backgroundImage); if (g.length) { layers.push(fg ? g.reduce((w, c) => ratio(fg, c) < ratio(fg, w) ? c : w) : g[0]); break; } const c = rgba(cs.backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } } let acc = { r: 255, g: 255, b: 255, a: 1 }; for (const l of layers.reverse()) acc = over(l, acc); return acc; };
	const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
	const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
	const VIS = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0 && !e.closest('.visually-hidden, [hidden], [aria-hidden=true]'); };
	const large = (s) => { const px = parseFloat(s.fontSize); const bold = Number(s.fontWeight) >= 700 || s.fontWeight === 'bold'; return px >= 24 || (bold && px >= 18.66); };
	const label = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
`;
