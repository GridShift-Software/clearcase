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

/** Where focus is: 'confirm', 'cancel', 'opener' (the element `opener` selects), 'body', or the focused tag. */
export const focusOf = (p, opener) => p.evaluate(`(() => { const a = document.activeElement; if (!a || a === document.body) return 'body'; if (a.hasAttribute('data-delete-confirm')) return 'confirm'; if (a.hasAttribute('data-delete-cancel')) return 'cancel'; return a === document.querySelector(${JSON.stringify(opener)}) ? 'opener' : a.tagName; })()`);

/** A real Escape key press. */
export async function pressEscape(p) {
	for (const type of ['keyDown', 'keyUp']) await p.s('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}

/** POST `fields` to `action` (`?/delete`) of the open page as a script would, with no confirmation unless given: the action result's type, status and serialized data. */
export const postAction = (p, action, fields) => p.evaluate(`(async () => { const fd = new FormData(); for (const [k, v] of Object.entries(${JSON.stringify(fields)})) fd.set(k, v); const r = await fetch(location.pathname + ${JSON.stringify(action)}, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true', accept: 'application/json' } }); const j = await r.json().catch(() => null); return { type: j?.type ?? null, status: j?.status ?? null, data: typeof j?.data === 'string' ? j.data.slice(0, 400) : null }; })()`);
