import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import AppShell from './AppShell.svelte';
import TopBar from './TopBar.svelte';
import UnavailableView from './UnavailableView.svelte';
import ViewNav from './ViewNav.svelte';
import { isSearchShortcut } from './shell-keys.ts';
import type { ShellData } from './shell.ts';
import { viewById } from './views.ts';

const RV = `sha256:${'c'.repeat(64)}`;
const shell: ShellData = {
	brand: 'ClearCase',
	caseName: 'Synthetic v Example',
	base: '/v',
	resultsVersion: RV,
	current: 'overview',
	published: { label: 'Published', at: null, documents: 12 },
	searchHref: '/v/x/evidence/search',
	account: null,
	actions: [{ label: 'All cases', href: '/cases' }],
};
const key = (over: Partial<Parameters<typeof isSearchShortcut>[0]>) => ({ key: 'k', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over });

describe('the search shortcut', () => {
	it('is Ctrl+K or Cmd+K, in either case', () => {
		expect(isSearchShortcut(key({ ctrlKey: true }))).toBe(true);
		expect(isSearchShortcut(key({ metaKey: true }))).toBe(true);
		expect(isSearchShortcut(key({ ctrlKey: true, key: 'K' }))).toBe(true);
	});
	it('is not plain k, another key, or a chord with Alt or Shift', () => {
		expect(isSearchShortcut(key({}))).toBe(false);
		expect(isSearchShortcut(key({ ctrlKey: true, key: 'j' }))).toBe(false);
		expect(isSearchShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
		expect(isSearchShortcut(key({ metaKey: true, shiftKey: true }))).toBe(false);
	});
});

describe('the navigation drawer toggle', () => {
	it('is a labelled button that says the drawer is closed and which region it controls', () => {
		const out = render(TopBar, { props: { shell, navControls: 'case-side', ontoggle: () => {} } }).body;
		const tag = /<button[^>]*id="nav-toggle"[^>]*>/.exec(out)?.[0] ?? '';
		expect(tag).toContain('type="button"');
		expect(tag).toContain('aria-label="Case navigation"');
		expect(tag).toContain('aria-expanded="false"');
		expect(tag).toContain('aria-controls="case-side"');
	});
	it('reports an open drawer, and is absent when nothing handles it', () => {
		expect(render(TopBar, { props: { shell, navOpen: true, ontoggle: () => {} } }).body).toContain('aria-expanded="true"');
		expect(render(TopBar, { props: { shell } }).body).not.toContain('nav-toggle');
	});
	it('starts closed in the shell: the toggle controls the sidebar, and there is no backdrop', () => {
		const sidebar = (() => '') as never;
		const out = render(AppShell, { props: { shell, sidebar, children: (() => '') as never } }).body;
		expect(out).toMatch(/id="case-side"/);
		expect(out).toMatch(/aria-controls="case-side"/);
		expect(out).toContain('aria-expanded="false"');
		expect(out).not.toContain('nav-open');
		expect(out).not.toContain('drawer-backdrop');
	});
});

describe('the sidebar', () => {
	const nav = (props: Record<string, unknown>) => render(ViewNav, { props: { resultsVersion: RV, ...props } }).body;
	it('marks only the current view with aria-current="page"', () => {
		const out = nav({ current: 'chronology' });
		expect(out.match(/aria-current="page"/g)).toHaveLength(1);
		expect(/<a [^>]*aria-current="page"[^>]*data-view="chronology"|<a [^>]*data-view="chronology"[^>]*aria-current="page"/.test(out)).toBe(true);
	});
	it('numbers its entries in CSS, so a link keeps its label as its first text', () => {
		const css = readFileSync(new URL('../../app.css', import.meta.url), 'utf8');
		expect(css).toMatch(/nav\.views a::before\s*\{[^}]*counter-increment: nav-n/);
		expect(nav({})).not.toMatch(/class="nav-n"/);
	});
});

describe('the coming-soon card', () => {
	it('hides its icon from assistive technology and names the return link', () => {
		const out = render(UnavailableView, { props: { view: viewById('risk_matrix_tab')!, caseName: 'Synthetic v Example', status: 'soon', resultsVersion: RV } }).body;
		expect(out).toMatch(/<span class="uv-icon" aria-hidden="true">/);
		expect(out).toMatch(/<h2 class="uv-title">Coming soon<\/h2>/);
		expect(out).toContain('>Back to Overview</a>');
	});
});

describe('the stylesheet', () => {
	const css = readFileSync(new URL('../../app.css', import.meta.url), 'utf8');
	it('declares no web font', () => {
		expect(css).not.toContain('@font-face');
		expect(css).not.toMatch(/url\([^)]*\.woff2?/);
		expect(css).toMatch(/--font-sans:[^;]*sans-serif;/);
	});
	it('sets the shell geometry from the prototype', () => {
		expect(css).toContain('--nav-w: 240px;');
		expect(css).toContain('--topbar-h: 56px;');
		expect(css).toContain('--radius-card: 6px;');
		expect(css).toMatch(/:focus-visible \{ outline: 2px solid var\(--focus\); outline-offset: 2px; \}/);
	});
});
