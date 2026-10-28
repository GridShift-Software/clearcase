import { render } from 'svelte/server';
import { describe, expect, test } from 'vitest';
import { versionPath } from '../local-case/model.ts';
import ViewNav from './ViewNav.svelte';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
// the module script's exports (a .svelte import has only a default export to tsc; vitest compiles the component)
const { queryKey, savedQuery, saveQuery, rememberQueries } = (await import('./ViewNav.svelte')) as unknown as {
	queryKey: (caseId: string, viewId: string) => string;
	savedQuery: (store: Pick<Storage, 'getItem'> | null, caseId: string, viewId: string) => string;
	saveQuery: (store: Pick<Storage, 'setItem' | 'removeItem'> | null, caseId: string, viewId: string, search: string) => void;
	rememberQueries: (store: Store | null, caseId: string, resultsVersion: string, current: string | null, address: { pathname: string; search: string }, base?: string) => Record<string, string>;
};

function memory() {
	const map = new Map<string, string>();
	return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, String(v)), removeItem: (k: string) => void map.delete(k) };
}
const fail = (name: string) => () => { throw new DOMException(name, name); };
const blocked: Store = { getItem: fail('SecurityError'), setItem: fail('SecurityError'), removeItem: fail('SecurityError') };
const RV = `sha256:${'a'.repeat(64)}`;
const at = (route: string, search = '') => ({ pathname: `${versionPath(RV)}${route}`, search });

describe('the key', () => {
	test('one key per case and view; the case id is encoded, so it cannot run into the view id', () => {
		expect(queryKey('synthetic-case', 'chronology')).toBe('clearcase:view-query:synthetic-case:chronology');
		expect(queryKey('case one', 'search')).toBe('clearcase:view-query:case%20one:search');
		expect(queryKey('a:b', 'c')).not.toBe(queryKey('a', 'b:c'));
		expect(new Set([queryKey('c1', 'chronology'), queryKey('c2', 'chronology'), queryKey('c1', 'search')]).size).toBe(3);
	});
});

describe('storage handling', () => {
	test('a query is saved and read back for its case and view only; an empty one forgets it', () => {
		const s = memory();
		saveQuery(s, 'c1', 'chronology', '?q=zebra&sort=amount');
		expect(savedQuery(s, 'c1', 'chronology')).toBe('?q=zebra&sort=amount');
		expect([savedQuery(s, 'c2', 'chronology'), savedQuery(s, 'c1', 'search')]).toEqual(['', '']);
		saveQuery(s, 'c1', 'chronology', '');
		expect(s.map.size).toBe(0);
		saveQuery(s, 'c1', 'chronology', '?');
		expect(s.map.size).toBe(0);
	});

	test('a stored value that is not a query string is ignored, and such a value is never saved', () => {
		const s = memory();
		for (const v of ['q=x', '/evidence/search', '?q=x#top', '#top', `?q=${'x'.repeat(5000)}`, '']) {
			s.map.set(queryKey('c', 'chronology'), v);
			expect(savedQuery(s, 'c', 'chronology')).toBe('');
		}
		saveQuery(s, 'c', 'search', '?q=x#top');
		expect(s.map.has(queryKey('c', 'search'))).toBe(false);
	});

	test('blocked or full storage, or none at all, gives no saved query and throws nothing', () => {
		const full = { ...memory(), setItem: fail('QuotaExceededError') };
		expect(savedQuery(blocked, 'c', 'chronology')).toBe('');
		expect(() => saveQuery(blocked, 'c', 'chronology', '?q=1')).not.toThrow();
		expect(() => saveQuery(full, 'c', 'chronology', '?q=1')).not.toThrow();
		expect(savedQuery(null, 'c', 'chronology')).toBe('');
		expect(() => saveQuery(null, 'c', 'chronology', '?q=1')).not.toThrow();
		expect(rememberQueries(blocked, 'c', RV, 'chronology', at('/chronology', '?q=1')).chronology).toBe('');
	});
});

describe('after a navigation', () => {
	test("the current view's address query is saved, and every view's saved query is returned", () => {
		const s = memory();
		const q = rememberQueries(s, 'c', RV, 'chronology', at('/chronology', '?q=zebra'));
		expect(q.chronology).toBe('?q=zebra');
		expect(Object.keys(q)).toHaveLength(42);
		expect(Object.entries(q).filter(([, v]) => v)).toEqual([['chronology', '?q=zebra']]);
		expect(rememberQueries(s, 'c', RV, 'search', at('/evidence/search')).chronology).toBe('?q=zebra');
		expect(rememberQueries(s, 'c', RV, 'chronology', at('/chronology')).chronology).toBe('');
	});

	test('nothing is saved while the address is not the current view (mid-navigation), or for a page that is no view', () => {
		const s = memory();
		saveQuery(s, 'c', 'chronology', '?q=zebra');
		expect(rememberQueries(s, 'c', RV, 'chronology', at('/evidence/search')).chronology).toBe('?q=zebra');
		expect(rememberQueries(s, 'c', RV, '[ref]', at('/doc/EX-001', '?page=2'))).not.toHaveProperty('[ref]');
		expect([...s.map.keys()]).toEqual([queryKey('c', 'chronology')]);
	});
});

describe('under a route base', () => {
	const HOSTED = '/cases/c1/v';
	const nav = (props: Record<string, unknown>, base?: string) =>
		render(ViewNav, { props: { resultsVersion: RV, ...props }, ...(base ? { context: new Map([['clearcase:base', () => base]]) } : {}) }).body;
	const links = (html: string) => [...html.matchAll(/<a ([^>]*)>/g)].map((m) => m[1]!);
	const attr = (a: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(a)?.[1] ?? null;

	test('every entry links under the base the layout sets, and under /v without one', () => {
		const local = links(nav({}));
		expect(local).toHaveLength(42);
		expect(local.every((a) => attr(a, 'href')!.startsWith(`${versionPath(RV)}/`))).toBe(true);
		const hosted = links(nav({}, HOSTED));
		expect(hosted.every((a) => attr(a, 'href')!.startsWith(`${versionPath(RV, HOSTED)}/`))).toBe(true);
	});

	test('with hosted set, soon entries are disabled and marked, ported entries are plain, and no system entry is shown', () => {
		const hosted = links(nav({ hosted: true }, HOSTED));
		const byView = new Map(hosted.map((a) => [attr(a, 'data-view')!, a]));
		expect([...byView.keys()].filter((id) => ['rescan_tab', 'backup_tab', 'manual'].includes(id))).toEqual([]);
		expect(hosted).toHaveLength(39);
		expect(attr(byView.get('overview')!, 'data-hosted-status')).toBe('ported');
		expect(attr(byView.get('overview')!, 'aria-disabled')).toBeNull();
		for (const id of ['chronology', 'popia_tab', 'risk_matrix_tab']) {
			expect(attr(byView.get(id)!, 'data-hosted-status')).toBe('soon');
			expect(attr(byView.get(id)!, 'aria-disabled')).toBe('true');
		}
		expect(nav({ hosted: true }, HOSTED)).not.toMatch(/>System</);
	});

	test('without hosted, nothing carries a hosted status', () => {
		expect(nav({})).not.toContain('data-hosted-status');
		expect(nav({})).not.toContain('aria-disabled');
	});

	test("the current view's query is remembered under the base", () => {
		const s = memory();
		const q = rememberQueries(s, 'c', RV, 'chronology', { pathname: `${versionPath(RV, HOSTED)}/chronology`, search: '?q=zebra' }, HOSTED);
		expect(q.chronology).toBe('?q=zebra');
		expect(rememberQueries(memory(), 'c', RV, 'chronology', { pathname: `${versionPath(RV)}/chronology`, search: '?q=zebra' }, HOSTED).chronology).toBe('');
	});
});
