// The verdicts of the UI class suite (GRS-59) on recorded evidence: a refused or failed save never passes inflight-ok,
// a save that took effect does, and the verdict still refuses an inert field that only looked fine (no browser needed).
import { describe, expect, test } from 'vitest';
import { toCSV, userCell } from '../../../src/lib/components/csv.ts';
// @ts-expect-error plain .mjs
import { actionResult, csvChecks, csvFileEvidence, dialogChecks, inflightChecks } from '../classes/verdicts.mjs';

const json = (http: number, body: object) => ({ http, body: JSON.stringify(body) });
const SUCCESS = json(200, { type: 'success', status: 200, data: '[{"restored":1},3]' });
const REDIRECT = json(200, { type: 'redirect', status: 303, location: '/x' });
const REFUSED_400 = json(200, { type: 'failure', status: 400, data: '[{"message":1},"Type the full path of the backup file."]' });
const PLAIN_400 = { http: 400, body: 'Bad Request' };
const ERROR_500 = json(500, { type: 'error', status: 500, error: { message: 'Internal Error' } });
const PLAIN_500 = { http: 500, body: '<html>Internal Error</html>' };

describe('actionResult', () => {
	test('a success and the action\'s success redirect are saves', () => {
		expect(actionResult(SUCCESS)).toMatchObject({ ok: true, kind: 'success', status: 200 });
		expect(actionResult(REDIRECT)).toMatchObject({ ok: true, kind: 'redirect', status: 303 });
		expect(actionResult({ http: 200, body: 'saved' }).ok).toBe(true);
	});
	test('a 400 and a 500, as SvelteKit sends them or plain, are not', () => {
		for (const r of [REFUSED_400, PLAIN_400, ERROR_500, PLAIN_500, json(200, { type: 'failure', status: 409 }), json(200, { type: 'redirect', status: 200 })]) expect(actionResult(r).ok, JSON.stringify(r)).toBe(false);
	});
	test('no response, or a response without a status, is not one', () => {
		for (const r of [null, undefined, {}, { body: '{}' }]) expect(actionResult(r)).toMatchObject({ ok: false, kind: 'none' });
	});
});

// what a scenario recorded for an inert field (the held request continued, nothing typed in flight)
const ev = (result: unknown, over: object = {}) => ({ mode: 'ok', edit: false, paused: { request: {} }, inert: true, accepted: false, kept: false, errors: [], result: actionResult(result), effect: true, ...over });
const passes = (checks: Record<string, unknown>) => Object.values(checks).length > 0 && Object.values(checks).every((x) => x === true);

describe('inflightChecks in mode ok', () => {
	test('a 2xx save that took effect passes, with the field inert or typed into', () => {
		expect(passes(inflightChecks(ev(SUCCESS)))).toBe(true);
		expect(passes(inflightChecks(ev(REDIRECT)))).toBe(true);
		expect(passes(inflightChecks(ev(SUCCESS, { inert: false, accepted: true, kept: true })))).toBe(true);
	});
	test('a 400 or a 500 cannot pass, even with an inert field and a refusal message shown (the backup path "Synthetic path")', () => {
		const refusal = [{ id: 'restore-error', text: 'Type the full path of the backup file (for example /home/me/clearcase-backup.json). Nothing was changed.', form: null }];
		for (const r of [REFUSED_400, PLAIN_400, ERROR_500, PLAIN_500]) {
			for (const effect of [true, false]) {
				const c = inflightChecks(ev(r, { effect, errors: refusal }));
				expect(c.saved, JSON.stringify(r)).toBe(false);
				expect(passes(c)).toBe(false);
			}
		}
	});
	test('a 2xx without the save\'s effect, or with no response, cannot pass', () => {
		expect(passes(inflightChecks(ev(SUCCESS, { effect: false })))).toBe(false);
		expect(passes(inflightChecks(ev(null)))).toBe(false);
	});
	test('an edit scenario also needs its set-up save and the edit mode', () => {
		expect(passes(inflightChecks(ev(SUCCESS, { edit: true, editing: true, seeded: true })))).toBe(true);
		expect(passes(inflightChecks(ev(SUCCESS, { edit: true, editing: true, seeded: false })))).toBe(false);
		expect(passes(inflightChecks(ev(SUCCESS, { edit: true, editing: false, seeded: true })))).toBe(false);
	});
});

describe('inflightChecks in mode fail', () => {
	const lost = { mode: 'fail', paused: {}, inert: true, accepted: false, kept: false, errors: [{ text: 'The save was not saved: the request was lost.' }], result: actionResult(null) };
	test('a lost request with its message passes', () => expect(passes(inflightChecks(lost))).toBe(true));
	test('no message, or a request that was answered, does not', () => {
		expect(passes(inflightChecks({ ...lost, errors: [] }))).toBe(false);
		expect(passes(inflightChecks({ ...lost, result: actionResult(SUCCESS) }))).toBe(false);
	});
});


describe('dialog evidence must prove an answer (GRS-61)', () => {
	const evidence = { setUpSaved: true, inApp: true, paused: {}, asked: 'edit', answered: 'Discard it', questionClosed: true, closedBySave: false, closedBySaveReason: null, onPage: true, holds: true, errors: [{ text: 'The entry was not saved.' }] };
	test('passes a clicked answer only after the question closes, with the error beside its own text', () => {
		expect(passes(dialogChecks(evidence))).toBe(true);
		for (const over of [{ questionClosed: false }, { answered: 'disabled' }, { answered: null }, { holds: false }, { errors: [] }, { paused: null }]) {
			expect(passes(dialogChecks({ ...evidence, ...over })), JSON.stringify(over)).toBe(false);
		}
	});
	test('requires a per-target reason and observed closure when the save takes back the question', () => {
		const closed = { ...evidence, answered: null, closedBySave: true };
		expect(passes(dialogChecks(closed))).toBe(false);
		expect(passes(dialogChecks({ ...closed, closedBySaveReason: 'this target closes its edit question at save start' }))).toBe(true);
		expect(passes(dialogChecks({ ...closed, closedBySaveReason: 'declared', questionClosed: false }))).toBe(false);
	});
	test('a failed save must leave no error on the page left for', () => {
		expect(passes(dialogChecks({ ...evidence, onPage: false, errors: [] }))).toBe(true);
		expect(passes(dialogChecks({ ...evidence, onPage: false }))).toBe(false);
	});
});

describe('CSV evidence cannot pass without checking CSV (GRS-61)', () => {
	test('no CSV, including a download set containing only ICS or TXT, cannot pass', () => {
		expect(passes(csvChecks([]))).toBe(false);
		expect(passes(csvChecks([csvFileEvidence({ name: 'empty.csv', text: 'safe' })]))).toBe(false);
	});
	test('does not miss a formula preceded by more than twenty spaces after a delimiter', () => {
		const file = csvFileEvidence({ name: 'synthetic.csv', text: `safe;${' '.repeat(40)}=CCX(1),safe` });
		expect(file.bad).toBe(1);
		expect(passes(csvChecks([file]))).toBe(false);
	});
	for (const sep of [';', '\t', '\r', '\n']) {
		for (const lead of ['=', '+', '-', '@']) {
			test(`detects a formula after ${JSON.stringify(sep)} and ${lead} in every column`, () => {
				for (let col = 0; col < 3; col++) {
					const cells = ['synthetic', 'synthetic', 'synthetic'];
					cells[col] = `synthetic${sep} ${lead}CCX(1)`;
					const unsafe = csvFileEvidence({ name: 'synthetic.csv', text: cells.join(',') });
					expect(unsafe.bad).toBe(1);
					expect(passes(csvChecks([unsafe]))).toBe(false);
					const safe = csvFileEvidence({ name: 'synthetic.csv', text: toCSV([cells.map(userCell)]) });
					expect(safe.bad).toBe(0);
					expect(passes(csvChecks([safe]))).toBe(true);
				}
			});
		}
	}
});
