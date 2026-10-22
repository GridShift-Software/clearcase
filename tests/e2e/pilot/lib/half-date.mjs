// GRS-181: a half-typed Add date (the month typed, the rest empty) holds a bad input, so its form fails the browser's
// own validation. Delete, Confirm delete and Cancel submit that form, so they must not be stopped by it.
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Type "10" into the month segment of the date input `sel` as a keyboard does and return its validity: the value stays empty, `bad` is true. */
export async function halfTypeDate(p, sel) {
	await p.evaluate(`document.querySelector(${J(sel)}).focus()`);
	for (const ch of '10') {
		const k = { key: ch, code: `Digit${ch}`, windowsVirtualKeyCode: 48 + Number(ch) };
		await p.s('Input.dispatchKeyEvent', { type: 'keyDown', ...k, text: ch });
		await p.s('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
	}
	const v = await p.evaluate(`(() => { const e = document.querySelector(${J(sel)}); return { value: e.value, bad: e.validity.badInput }; })()`);
	if (v.value !== '' || !v.bad) throw new Error(`half-typed date: ${sel} holds ${J(v)}, not an incomplete date`);
	return v;
}

/**
 * Draft, delete and confirm or cancel with scripts off, with a half-typed date in the Add form. `fill` types the draft and
 * half-types the date on the freshly loaded page; each post waits up to `wait` ms for the server's page and reports
 * `moved: false` when the browser submitted nothing (the form was stopped by its own validation).
 */
export async function draftThroughDeleteWithHalfDate(p, { url, ready, fill, draft, row, opener, wait = 4000 }) {
	await p.s('Emulation.setScriptExecutionDisabled', { value: true });
	try {
		const open = async () => {
			const nav = await p.navigate(url);
			if (nav.errorText) throw new Error(`navigate ${url}: ${nav.errorText}`);
			await p.waitFor(ready, 20000);
			await fill();
		};
		const post = async (selector) => {
			await p.evaluate('window.__draftRound = true');
			await p.click(selector);
			const moved = await p.waitFor(`window.__draftRound !== true && (${ready})`, wait).then(() => true, () => false);
			if (!moved) await sleep(200);
			return { moved, ...(await p.evaluate(`({ value: document.querySelector(${J(draft)})?.value ?? null, row: !!document.querySelector(${J(row)}), asking: !!document.querySelector(${J(`${row} [data-delete-confirm]`)}) })`)) };
		};
		await open();
		const askedBeforeCancel = await post(opener);
		const cancelled = await post(`${row} [data-delete-cancel]`);
		await open();
		const askedBeforeConfirm = await post(opener);
		const confirmed = await post(`${row} [data-delete-confirm]`);
		return { askedBeforeCancel, cancelled, askedBeforeConfirm, confirmed };
	} finally { await p.s('Emulation.setScriptExecutionDisabled', { value: false }); }
}
