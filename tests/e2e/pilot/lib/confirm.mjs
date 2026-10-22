// GRS-175: a register row's Delete, and the Court Bundle header's Restore and Clear, ask inline before they act (v5 acts
// at once). Drivers that press one of them press its Confirm next.

const shown = (p, sel) => p.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`).catch(() => false);

/** Press the inline Confirm of the action just pressed, within `scope` (a selector), once it shows; false when it never does. */
export async function confirmIfAsked(p, scope = '', ms = 5000) {
	const sel = `${scope} [data-delete-confirm]`.trim();
	for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 25))) if (await shown(p, sel)) { await p.click(sel); return true; }
	return false;
}

/** confirmIfAsked that throws when no confirmation shows: the action must ask. */
export async function confirmPressed(p, scope = '', ms = 5000) {
	if (!(await confirmIfAsked(p, scope, ms))) throw new Error(`no inline confirmation at ${`${scope} [data-delete-confirm]`.trim()}`);
}

/** The targets whose confirmation shows (data-confirming). */
export const asking = (p) => p.evaluate(`[...document.querySelectorAll('[data-confirming]')].map((e) => e.dataset.confirming)`);

/** Where focus is: 'confirm', 'cancel', 'question' (the question's group), 'opener' (the element `opener` selects), 'body', or the focused tag. */
export const focusOf = (p, opener) => p.evaluate(`(() => { const a = document.activeElement; if (!a || a === document.body) return 'body'; if (a.hasAttribute('data-delete-confirm')) return 'confirm'; if (a.hasAttribute('data-delete-cancel')) return 'cancel'; if (a.hasAttribute('data-confirming')) return 'question'; return a === document.querySelector(${JSON.stringify(opener)}) ? 'opener' : a.tagName; })()`);

/** The text of the elements the focused element's aria-describedby names, or null when it names none. */
export const describedBy = (p) => p.evaluate(`(() => { const ids = document.activeElement?.getAttribute('aria-describedby')?.split(/\\s+/).filter(Boolean) ?? []; return ids.length ? ids.map((id) => document.getElementById(id)?.textContent.trim() ?? '').join(' ') : null; })()`);

/** A real Escape key press. */
export async function pressEscape(p) {
	for (const type of ['keyDown', 'keyUp']) await p.s('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}

/** POST `fields` to `action` (`?/delete`) of the open page as a script would, with no confirmation unless given: the action result's type, status and serialized data. */
export const postAction = (p, action, fields) => p.evaluate(`(async () => { const fd = new FormData(); for (const [k, v] of Object.entries(${JSON.stringify(fields)})) fd.set(k, v); const r = await fetch(location.pathname + ${JSON.stringify(action)}, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true', accept: 'application/json' } }); const j = await r.json().catch(() => null); return { type: j?.type ?? null, status: j?.status ?? null, data: typeof j?.data === 'string' ? j.data.slice(0, 400) : null }; })()`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Hold Enter on the focused element as a keyboard does: an optional first press, then `repeats` auto-repeat keydowns (`autoRepeat: true`), then the release. */
export async function holdEnter(p, { first = false, repeats = 6 } = {}) {
	const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' };
	if (first) await p.s('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
	for (let i = 0; i < repeats; i++) { await sleep(20); await p.s('Input.dispatchKeyEvent', { type: 'keyDown', ...key, autoRepeat: true }); }
	await p.s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}

const ENTER = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
const TAB = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 };

/**
 * Without JavaScript (scripts off before `url` loads), hold Enter on the Delete `opener` selects as a keyboard does: the
 * first keydown submits it, and the auto-repeat keydowns go on arriving after the server's ask page has loaded and its
 * autofocus has run. Then one Tab. Returns whether the page hydrated, what the ask page asked and focused, whether the
 * repeats submitted anything and what shows after them, and where Tab moved focus. Scripts are on again when it returns;
 * load the page again before driving it with them.
 */
export async function holdEnterWithoutJs(p, url, ready, opener, repeats = 12) {
	await p.s('Emulation.setScriptExecutionDisabled', { value: true });
	try {
		const nav = await p.navigate(url);
		if (nav.errorText) throw new Error(`navigate ${url}: ${nav.errorText}`);
		await p.waitFor(ready, 20000);
		const hydrated = await p.evaluate(`!!document.querySelector('main#main[data-hydrated]')`);
		await p.evaluate(`document.querySelector(${JSON.stringify(opener)}).focus(); window.__held = 1`);
		await p.s('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER, text: '\r' });
		await p.waitFor(`window.__held !== 1 && document.readyState === 'complete' && (${ready})`, 20000);
		await p.waitFor(`document.activeElement !== document.body`, 3000).catch(() => false);
		const asked = { asking: await asking(p), focus: await focusOf(p, opener) };
		await p.evaluate('window.__held = 2');
		for (let i = 0; i < repeats; i++) { await sleep(33); await p.s('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER, text: '\r', autoRepeat: true }); }
		await p.s('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
		await sleep(1500);
		await p.waitFor(`document.readyState === 'complete' && (${ready})`, 20000);
		const held = { submitted: await p.evaluate('window.__held !== 2'), asking: await asking(p), focus: await focusOf(p, opener) };
		for (const type of ['keyDown', 'keyUp']) await p.s('Input.dispatchKeyEvent', { type, ...TAB });
		return { hydrated, asked, held, tab: await focusOf(p, opener) };
	} finally { await p.s('Emulation.setScriptExecutionDisabled', { value: false }); }
}

/** Press the inline Cancel within `scope` when a question shows, so the next step starts from the Delete. */
export async function cancelIfAsked(p, scope = '') {
	const sel = `${scope} [data-delete-cancel]`.trim();
	if (await shown(p, sel)) await p.click(sel);
}
