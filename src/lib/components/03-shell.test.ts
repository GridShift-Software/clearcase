import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { documentRoute } from '../case-package/render.ts';
import { docPath, versionPath } from '../local-case/model.ts';
import TopBar from './TopBar.svelte';
import UnavailableView from './UnavailableView.svelte';
import type { ShellData } from './shell.ts';
import { viewById, viewHref } from './views.ts';

const RV = `sha256:${'b'.repeat(64)}`;
const ENC = encodeURIComponent(RV);
const HOSTED = '/cases/c1/v';

describe('route base', () => {
	it('keeps the local paths when no base is given', () => {
		expect(versionPath(RV)).toBe(`/v/${ENC}`);
		expect(documentRoute(RV, 'DOC-1')).toBe(`/v/${ENC}/doc/DOC-1`);
		expect(documentRoute(RV, 'DOC-1', 3)).toBe(`/v/${ENC}/doc/DOC-1?page=3`);
		expect(docPath(RV, 'DOC 1', null)).toBe(`/v/${ENC}/doc/DOC%201`);
		expect(viewHref(RV, viewById('chronology')!)).toBe(`/v/${ENC}/chronology`);
	});

	it('puts every path under a hosted base', () => {
		expect(versionPath(RV, HOSTED)).toBe(`/cases/c1/v/${ENC}`);
		expect(documentRoute(RV, 'DOC-1', 3, HOSTED)).toBe(`/cases/c1/v/${ENC}/doc/DOC-1?page=3`);
		expect(docPath(RV, 'DOC-1', null, HOSTED)).toBe(`/cases/c1/v/${ENC}/doc/DOC-1`);
		expect(viewHref(RV, viewById('risk_matrix_tab')!, HOSTED)).toBe(`/cases/c1/v/${ENC}/analysis/risk_matrix_tab`);
	});
});

const shell = (over: Partial<ShellData> = {}): ShellData => ({
	brand: 'ClearCase',
	caseName: 'Synthetic v Example',
	base: HOSTED,
	resultsVersion: RV,
	current: 'overview',
	published: { label: 'Published', at: '2026-10-01T09:00:00.000Z', documents: 1234 },
	searchHref: `${HOSTED}/${ENC}/evidence/search`,
	account: { name: 'Pat Example', signOutHref: '/sign-out' },
	actions: [{ label: 'All cases', href: '/cases' }],
	...over,
});

describe('TopBar', () => {
	it('renders the search form, version pill and account controls from the shell data', () => {
		const out = render(TopBar, { props: { shell: shell() } }).body;
		expect(out).toMatch(new RegExp(`<form[^>]*method="GET"[^>]*action="${HOSTED}/${ENC}/evidence/search"`));
		expect(out).toMatch(/<input[^>]*name="q"[^>]*data-testid="search-input"/);
		expect(out).toMatch(/<button[^>]*type="submit"[^>]*data-testid="search-submit"/);
		expect(out).toContain('ClearCase');
		expect(out).toContain('Synthetic v Example');
		const pill = /data-testid="version-pill"[^>]*>([\s\S]*?)<\/p>/.exec(out)?.[1] ?? '';
		expect(pill).toContain('Published');
		expect(pill).toContain('1,234 documents');
		expect(pill).toContain('2026-10-01');
		expect(out).toMatch(/data-testid="account-name"[^>]*>Pat Example</);
		expect(out).toMatch(/<form[^>]*method="POST"[^>]*action="\/sign-out"[\s\S]*?<button[^>]*data-testid="sign-out"/);
		expect(out).toMatch(/<a href="\/cases">All cases<\/a>/);
	});

	it('says an unpublished version is not published, and shows no account controls without an account', () => {
		const out = render(TopBar, { props: { shell: shell({ published: null, account: null, actions: [] }) } }).body;
		const pill = /data-testid="version-pill"[^>]*>([\s\S]*?)<\/p>/.exec(out)?.[1] ?? '';
		expect(pill).toContain('Not published');
		expect(out).toMatch(/data-testid="version-pill"[^>]*data-published="false"/);
		expect(out).not.toContain('account-name');
		expect(out).not.toContain('sign-out');
	});

	it('keeps imported names as text', () => {
		const out = render(TopBar, { props: { shell: shell({ caseName: '<img src=x onerror=alert(1)>' }) } }).body;
		expect(out).not.toContain('<img');
	});
});

describe('UnavailableView with a hosted status', () => {
	const view = viewById('risk_matrix_tab')!;
	it('says coming soon and links back to the overview under the base, with no owner or blocker text', () => {
		const out = render(UnavailableView, { props: { view, caseName: 'Synthetic v Example', status: 'soon', resultsVersion: RV }, context: new Map([['clearcase:base', () => HOSTED]]) }).body;
		expect(out).toContain('Coming soon');
		expect(out).toContain(view.label);
		expect(out).toMatch(new RegExp(`<a[^>]*href="${HOSTED}/${ENC}/overview"[^>]*>Back to Overview</a>`));
		expect(out).toMatch(/data-hosted-status="soon"/);
		expect(out).not.toContain(view.owner);
		expect(out).not.toContain('owned by');
		expect(out).not.toMatch(/\d+ (documents|rows)/);
	});

	it('keeps the local wording without a status', () => {
		const out = render(UnavailableView, { props: { view, caseName: 'Synthetic v Example' } }).body;
		expect(out).toContain('is not yet available');
		expect(out).not.toContain('Coming soon');
	});
});
