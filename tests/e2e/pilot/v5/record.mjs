// Lane records for the real-v5 runner: each lane (or extra check group) collects the commands it ran, notes and
// assertions with expected and actual values, and ends PASS or FAIL. An exception or a failed precondition is a
// FAIL; nothing is skipped. Output goes only to the report directory, which may hold case values.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const show = (v) => { const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? String(x) : x)); return s === undefined ? 'undefined' : s.length > 700 ? `${s.slice(0, 700)}… (${s.length} chars)` : s; };

export class Precondition extends Error {}

export class Lane {
	constructor(id, title, { negativeControl = false } = {}) {
		this.id = id;
		this.title = title;
		this.negativeControl = negativeControl;
		this.lines = [];
		this.commands = [];
		this.checks = [];
		this.files = [];
		this.status = 'PENDING';
		this.error = null;
		this.ms = 0;
	}
	cmd(c) { this.commands.push(c); this.lines.push(`$ ${c}`); }
	note(s) { this.lines.push(`   ${s}`); }
	file(f) { this.files.push(f); return f; }
	/** Assert; `pass` defaults to deep equality of expected and actual. Returns whether it passed. */
	check(what, expected, actual, pass = isDeepStrictEqual(expected, actual)) {
		const ok = !!pass;
		this.checks.push({ what, expected, actual, pass: ok });
		this.lines.push(`${ok ? 'ok  ' : 'FAIL'} ${what}\n       expected: ${show(expected)}\n       actual:   ${show(actual)}`);
		return ok;
	}
	/** A check whose failure makes the rest of the lane meaningless. */
	need(what, expected, actual, pass) { if (!this.check(what, expected, actual, pass)) throw new Precondition(what); return actual; }
	get passed() { return this.status === 'PASS'; }
}

/** Run one lane body; any throw or failed check makes it FAIL. */
export async function runLane(lane, fn) {
	const t0 = performance.now();
	console.log(`--- ${lane.id} ${lane.title}`);
	try { await fn(lane); lane.status = lane.checks.length && lane.checks.every((c) => c.pass) ? 'PASS' : 'FAIL'; if (!lane.checks.length) lane.note('no assertions ran'); }
	catch (e) { lane.status = 'FAIL'; if (!(e instanceof Precondition)) { lane.error = String(e?.stack ?? e).slice(0, 4000); lane.lines.push(`ERROR ${lane.error}`); } }
	lane.ms = Math.round(performance.now() - t0);
	console.log(`${lane.status.padEnd(4)} ${lane.id} (${lane.checks.filter((c) => c.pass).length}/${lane.checks.length} assertions, ${lane.ms} ms)`);
	return lane;
}

export function writeLane(dir, lane, header) {
	const name = /^\d+$/.test(String(lane.id)) ? `lane-${String(lane.id).padStart(2, '0')}.txt` : `check-${lane.id}.txt`;
	const head = [
		`${/^\d+$/.test(String(lane.id)) ? `lane ${String(lane.id).padStart(2, '0')}` : `check ${lane.id}`}: ${lane.title}${lane.negativeControl ? ' [NEGATIVE CONTROL: disposable copy, not real-v5 parity evidence]' : ''}`,
		`status: ${lane.status}`,
		...header,
		`assertions: ${lane.checks.filter((c) => c.pass).length} passed, ${lane.checks.filter((c) => !c.pass).length} failed; ${lane.ms} ms`,
		`files: ${lane.files.join(', ') || 'none'}`,
		'',
	];
	writeFileSync(join(dir, name), [...head, ...lane.lines, ''].join('\n'));
	return name;
}
