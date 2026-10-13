// The verdicts of the UI class suite (GRS-59) on recorded evidence: a refused or failed save never passes inflight-ok,
// a save that took effect does, and the verdict still refuses an inert field that only looked fine (no browser needed).
import { describe, expect, test } from 'vitest';
// @ts-expect-error plain .mjs
import { actionResult, inflightChecks } from '../classes/verdicts.mjs';

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
