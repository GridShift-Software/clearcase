// Fail fast instead of hanging: every browser step of a runner (a parity view, an e2e scenario, a real-v5 lane, a
// measurement phase) runs under guard(), which ends it as soon as a browser this process launched dies or a target of
// it crashes (lib/cdp.mjs), or when the step outlives its deadline. The runner then stops, names the step and the
// cause, records `evidence: false` (abortReason) and exits non-zero within seconds; exitWithin() bounds its cleanup.
// A failed launch is retried once by lib/cdp.mjs launch() and recorded in `b.launch`.
import { BrowserDied, browserDeath, LaunchFailed, onBrowserDeath } from './cdp.mjs';

/** A step's deadline in ms: `ms`, or CLEARCASE_STEP_TIMEOUT_MS for every step (the fail-fast regressions shorten it). */
export const deadline = (ms) => +(process.env.CLEARCASE_STEP_TIMEOUT_MS ?? ms);

const human = (ms) => (ms >= 60000 && ms % 60000 === 0 ? `${ms / 60000} min` : `${Math.round(ms / 100) / 10} s`);

/** A step ended by a dead browser (kind 'browser'), a failed launch ('launch') or its deadline ('timeout'). */
export class StepAborted extends Error {
	constructor(step, cause, kind) {
		super(`${step}: ${cause}`);
		this.step = step;
		this.why = cause;
		this.kind = kind;
	}
	get record() { return { step: this.step, cause: this.why, kind: this.kind }; }
}

/**
 * Run fn() as the step `step`: it rejects with StepAborted when a live browser dies (also one that died before the
 * step started) or after `ms`, whatever fn() is waiting on; otherwise it settles as fn() does.
 */
export async function guard(step, ms, fn) {
	const dead = browserDeath();
	if (dead) throw new StepAborted(step, dead.message, 'browser');
	let timer, off;
	const stop = new Promise((_, rej) => {
		timer = setTimeout(() => rej(new StepAborted(step, `no result within ${human(ms)} (timeout)`, 'timeout')), ms);
		off = onBrowserDeath((e) => rej(new StepAborted(step, e.message, 'browser')));
	});
	try { return await Promise.race([Promise.resolve().then(fn), stop]); }
	catch (e) { throw abortOf(e, step) ?? e; }
	finally { clearTimeout(timer); off(); }
}

/**
 * The abort an error stands for, as StepAborted naming `step`: a StepAborted as it is, a failed launch, or any error
 * once a live browser has died (a command that rejected because the browser went away); else null.
 */
export function abortOf(e, step) {
	if (e instanceof StepAborted) return e;
	if (e instanceof LaunchFailed) return new StepAborted(step, e.message, 'launch');
	const dead = e instanceof BrowserDied ? e : browserDeath();
	return dead ? new StepAborted(step, dead.message, 'browser') : null;
}

/** The evidence reason for an abort (evidenceRecord's `other`): the run proves nothing past it. */
export const abortReason = (a) => `run aborted in ${a.step}: ${a.cause}`;

/** After an abort: if cleanup has not ended the process within `ms`, exit with `code` (a run never hangs). */
export function exitWithin(ms, code, who) {
	setTimeout(() => { console.error(`${who}: cleanup did not finish within ${human(ms)} of the abort; exiting`); process.exit(code); }, ms).unref();
}
