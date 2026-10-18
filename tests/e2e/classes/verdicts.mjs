// The verdicts of the UI class suite (GRS-59) that are plain functions of what a scenario recorded, so a unit test
// (tests/e2e/pilot/classes-verdicts.test.ts) can show that a refused save never passes a scenario that needs a save.

/** What the user sees of a refused or lost save: a message that says it was not saved. */
export const NOT_SAVED = /not saved|not been saved|could not be saved|was not saved|nothing was (changed|written)|lost|did not answer|try again/i;

/**
 * What the response to an action request says. SvelteKit answers an enhanced form with JSON ({ type, status }) and HTTP
 * 200 even when the action refuses (`type: 'failure'`), so the body decides; a response without that body is judged by
 * its HTTP status. A save succeeded when the action returned `success` (2xx) or its success `redirect` (3xx); a refusal
 * (`failure`, 4xx), a server `error` (5xx), an unreadable body or no response at all is not one.
 */
export function actionResult(res) {
	if (!res || typeof res.http !== 'number') return { ok: false, kind: 'none', status: null, http: null };
	const { http } = res;
	let j = null;
	try { j = typeof res.body === 'string' ? JSON.parse(res.body) : res.body; } catch { j = null; }
	if (j && typeof j === 'object' && typeof j.type === 'string') {
		const status = typeof j.status === 'number' ? j.status : http;
		const ok = http >= 200 && http < 400 && ((j.type === 'success' && status >= 200 && status < 300) || (j.type === 'redirect' && status >= 300 && status < 400));
		return { ok, kind: j.type, status, http };
	}
	return { ok: http >= 200 && http < 300, kind: 'http', status: http, http };
}

/**
 * The checks of an inflight scenario (text typed while a save is held, then let through or failed).
 *   mode ok:   the held request was answered with a success and the target's effect happened (the row stored, the
 *              restore reported); a refused save, a server error or an inert field alone never passes.
 *   mode fail: the request was lost (no response) and the page says it was not saved.
 * `e`: { mode, edit, editing, seeded, paused, inert, accepted, kept, errors, result (actionResult), effect }
 */
export function inflightChecks(e) {
	const ok = e.mode === 'ok';
	return {
		requestHeld: !!e.paused,
		...(e.edit ? { editing: e.editing === true, seeded: e.seeded === true } : {}),
		// the precondition: text went into the field in flight, or the field refused input (disabled, readonly, inert)
		typedOrInert: e.inert === true || e.accepted === true,
		notLost: !e.accepted || e.kept === true,
		...(ok
			? { saved: e.result?.ok === true, effect: e.effect === true }
			: { lost: !e.result || e.result.kind === 'none', failureShown: (e.errors ?? []).some((x) => NOT_SAVED.test(x.text)) }),
	};
}


/** A clicked answer or a declared save closure must actually close the question before the failed request is released. */
export function dialogChecks(e) {
	return {
		setUpSaved: e.setUpSaved === true,
		inApp: e.inApp === true,
		requestHeld: !!e.paused,
		asked: !!e.asked,
		answered: e.questionClosed === true && (
			(typeof e.answered === 'string' && e.answered !== '' && e.answered !== 'disabled') ||
			(e.answered === null && e.closedBySave === true && typeof e.closedBySaveReason === 'string' && e.closedBySaveReason.length > 0)),
		ownError: e.onPage ? (e.errors ?? []).some((x) => NOT_SAVED.test(x.text)) && e.holds === true : e.errors?.length === 0,
	};
}

/** Inspect every payload mark, including those in later columns and after each spreadsheet delimiter. */
export function csvFileEvidence(d) {
	const marks = [...d.text.matchAll(/[=+\-@"]CCX\(/g)];
	const bad = [...d.text.matchAll(/[;\t\r\n] *[=+\-@"]CCX\(/g)];
	return { name: d.name, bytes: d.text.length, marks: marks.length, bad: bad.length,
		sample: bad.slice(0, 3).map((m) => JSON.stringify(d.text.slice(Math.max(0, m.index - 30), m.index + 8))) };
}

export const csvChecks = (files) => ({
	exported: files.length > 0,
	hostileReached: files.every((c) => c.marks > 0),
	noFormula: files.every((c) => c.bad === 0),
});
