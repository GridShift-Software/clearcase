// The in-page extractor shared by both sides. `domExtract` is serialized into the page with Function.prototype
// .toString and run there, so it must stay self-contained (no imports, no closures over module scope). It reads what
// is visible under a root element and returns raw, unnormalized structure: headings, KPI cards, tables (HTML tables
// and ARIA grids), lists, paragraphs and the control inventory. Adapters turn this raw shape into a view snapshot.

/* eslint-disable no-undef */
export function domExtract(rootSel, opts = {}) {
	const root = typeof rootSel === 'string' ? document.querySelector(rootSel) : rootSel;
	if (!root) return null;
	const skip = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'SVG']);
	const hidden = (e) => {
		for (let x = e; x && x !== root.parentElement; x = x.parentElement) {
			if (x.hidden || x.getAttribute?.('aria-hidden') === 'true') return true;
			if (x.tagName === 'DETAILS' && !x.open && x !== e && !e.closest('summary')) return true;
		}
		return !e.getClientRects().length;
	};
	/** Visible text of an element: text nodes outside hidden subtrees; block children are separate parts. */
	const text = (e) => {
		let out = '';
		const walk = (n) => {
			if (n.nodeType === 3) { out += n.nodeValue; return; }
			if (n.nodeType !== 1 || skip.has(n.tagName.toUpperCase())) return;
			if (n.hidden || n.getAttribute('aria-hidden') === 'true') return;
			if (n.tagName === 'SELECT') return; // a select's options are inventoried as a control, not text
			const block = /^(DIV|P|LI|TR|H[1-6]|BR|SECTION|UL|OL|TABLE)$/.test(n.tagName);
			if (block) out += '\u0001';
			for (const c of n.childNodes) walk(c);
			if (block) out += '\u0001';
		};
		walk(e);
		return out;
	};
	const parts = (e) => text(e).split('\u0001').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
	const one = (e) => parts(e).join(' ');
	const within = (e) => root.contains(e) && !(opts.exclude && e.closest(opts.exclude));
	const all = (sel) => [...(root.matches(sel) ? [root] : []), ...root.querySelectorAll(sel)].filter((e) => e === root || within(e));

	const h1 = all('h1').map(one);
	const headings = all('h2, h3, h4').filter((e) => !hidden(e)).map((e) => ({ level: +e.tagName[1], text: one(e) }));
	const kpis = [];
	// v5 KPI cards: .kpi > .k (label) .v (value) .s (sub)
	for (const k of all('.kpi')) if (!hidden(k)) kpis.push({ label: one(k.querySelector('.k') ?? k), value: one(k.querySelector('.v') ?? k), sub: k.querySelector('.s') ? one(k.querySelector('.s')) : '' });
	// app KPI cards: section.card with a heading and a .num value
	for (const c of all('section.card')) {
		const h = c.querySelector('h2, h3'), v = c.querySelector('.num');
		if (h && v && !c.querySelector('table') && !hidden(c)) kpis.push({ label: one(h), value: one(v), sub: [...c.querySelectorAll('p')].filter((p) => p !== v && !p.contains(v)).map(one).join(' ') });
	}
	const tables = [];
	const caption = (t) => {
		const lab = t.getAttribute('aria-label');
		if (lab) return lab;
		for (let x = t; x && x !== root; x = x.parentElement) {
			let s = x.previousElementSibling;
			while (s) { if (/^H[1-6]$/.test(s.tagName)) return one(s); const h = s.querySelector?.('h2, h3, h4'); if (h && !s.querySelector('table, [role=table]')) return one(h); s = s.previousElementSibling; }
			const h = x.parentElement?.querySelector(':scope > h2, :scope > h3, :scope > h4');
			if (h) return one(h);
		}
		return '';
	};
	for (const t of all('table, [role=table]')) {
		if (hidden(t)) continue;
		const aria = t.getAttribute('role') === 'table';
		const rowEls = aria ? [...t.querySelectorAll('[role=row]')] : [...t.rows];
		const cellsOf = (r) => (aria ? [...r.querySelectorAll('[role=cell], [role=columnheader], [role=rowheader]')] : [...r.cells]);
		const headRow = aria ? rowEls.find((r) => r.querySelector('[role=columnheader]')) : (t.tHead?.rows[0] ?? null);
		const header = headRow ? cellsOf(headRow).map(one) : [];
		const body = rowEls.filter((r) => r !== headRow && !(t.tHead && t.tHead.contains(r)));
		const rows = body.map((r) => cellsOf(r).map((c) => parts(c)));
		const attrs = body.map((r) => Object.fromEntries([...r.attributes].filter((a) => a.name.startsWith('data-')).map((a) => [a.name, a.value])));
		tables.push({ caption: caption(t), header, rows, attrs, complete: t.getAttribute('data-complete') });
	}
	const lists = all('ul, ol').filter((e) => !hidden(e) && !e.closest('table, [role=table], nav') && !e.parentElement.closest('ul, ol')).map((e) => ({ caption: caption(e), items: [...e.children].filter((c) => c.tagName === 'LI').map(one) }));
	// key text blocks: paragraphs, v5 page meta and empty states, and v5 card text held directly in a div
	const isTextDiv = (e) => e.tagName === 'DIV' && e.parentElement?.classList.contains('card') && !e.querySelector('table, .kpi, button, select, input, textarea, p, h2, h3, h4') && e.className !== 'empty';
	const paragraphs = all('p, .meta, .empty, .card > div').filter((e) => e.tagName !== 'DIV' || isTextDiv(e) || e.matches('.meta, .empty')).filter((e) => !hidden(e) && !e.closest('table, [role=table], .kpi, li') && !(e.closest('section.card') && e.closest('section.card').querySelector('.num') && !e.closest('section.card').querySelector('table'))).map((e) => ({ section: caption(e), text: one(e), cls: e.className || '' })).filter((x) => x.text);
	const label = (e) => {
		const id = e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`);
		const wrap = e.closest('label');
		// a select is known by its first (placeholder) option on both sides; a v5 field by the label element before it
		if (e.tagName === 'SELECT') return (e.options[0]?.textContent ?? '').replace(/\s+/g, ' ').trim();
		const prev = e.previousElementSibling?.tagName === 'LABEL' ? e.previousElementSibling : null;
		return (e.getAttribute('aria-label') || (id && one(id)) || (wrap && one(wrap)) || (prev && one(prev)) || e.getAttribute('placeholder') || e.getAttribute('title') || one(e) || e.value || '').trim();
	};
	const controls = [];
	for (const e of all('button, select, input, textarea, a[href], a[data-tab], [role=button], [role=tab], th[onclick]')) {
		if (hidden(e)) continue;
		const tag = e.tagName.toLowerCase();
		// a clickable column header (v5 th onclick, app columnheader button) is one kind on both sides
		const kind = tag === 'th' || e.closest('[role=columnheader]') ? 'sort-header' : tag === 'input' ? `input:${(e.getAttribute('type') || 'text').toLowerCase()}` : tag === 'a' ? 'link' : e.getAttribute('role') === 'tab' ? 'tab' : tag === 'button' || e.getAttribute('role') === 'button' ? 'button' : tag;
		const c = { kind, label: label(e), id: e.id || null, disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true', inRow: !!e.closest('tbody tr, [role=row]:not(.grid-head)') && tag !== 'th' };
		if (c.inRow) {
			// a control inside a table row is known by its column header, not its label (a label can be the row's ref)
			const cell = e.closest('td, [role=cell]'), row = cell?.parentElement, table = row?.closest('table, [role=table]');
			const head = table?.matches('table') ? table.tHead?.rows[0] : table?.querySelector('[role=row]');
			const idx = row ? [...row.children].indexOf(cell) : -1;
			c.column = head && idx >= 0 ? one(head.children[idx] ?? head).replace(/\s*[▲▼]\s*$/, '') : '';
		}
		if (tag === 'select') { c.options = [...e.options].map((o) => o.textContent.replace(/\s+/g, ' ').trim()); c.value = e.value; }
		if (tag === 'a') { c.target = e.dataset.tab || e.getAttribute('href'); }
		controls.push(c);
	}
	const focus = document.activeElement && document.activeElement !== document.body ? { tag: document.activeElement.tagName.toLowerCase(), id: document.activeElement.id || null, text: one(document.activeElement).slice(0, 80) } : null;
	return { h1, headings, kpis, tables, lists, paragraphs, controls, focus, title: document.title };
}
