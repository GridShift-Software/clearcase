import { win32 } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain .mjs script, no declarations
import { anchors, check, slug } from '../../scripts/check-links.mjs';

// Make node:path behave as on Windows (backslash join/normalize); `posix` stays reachable as win32.posix, as in Node.
vi.mock('node:path', async () => {
	const { win32 } = await vi.importActual<typeof import('node:path')>('node:path');
	return { ...win32, default: win32 };
});

const run = (files: Record<string, string>) => check(Object.keys(files), (f: string) => files[f]);

describe('check-links', () => {
	it('slugs headings as GitHub does', () => {
		expect(slug('Toolchain and commands')).toBe('toolchain-and-commands');
		expect(slug('`gate`: one command, [the plan](x.md)!')).toBe('gate-one-command-the-plan');
		expect([...anchors('# A\n## A\n<a id="here"></a>\n```\n# not a heading\n```\n')]).toEqual(['a', 'a-1', 'here']);
	});

	it('slugs a heading with a code span through anchors() and check()', () => {
		expect([...anchors('## The `gate` command\n')]).toEqual(['the-gate-command']);
		expect(run({ 'a.md': '[ok](b.md#the-gate-command) [bad](b.md#the--command)', 'b.md': '## The `gate` command\n' })).toEqual(['a.md:1: b.md#the--command: no anchor #the--command in b.md']);
	});

	it('passes links to tracked files, directories and anchors', () => {
		expect(run({
			'README.md': '[dev](docs/development.md#setup) [docs](docs/) [self](#top) ![i](assets/icon.svg)\n# Top\n[ref]: docs/development.md',
			'docs/development.md': '## Setup\n[back](../README.md#top) [web](https://example.com/x.md) [abs](/etc/x)',
			'assets/icon.svg': '',
		})).toEqual([]);
	});

	it('reports a missing file, a missing anchor and a path outside the repository, with file and line', () => {
		expect(run({
			'README.md': 'intro\n[gone](docs/reviews/gone.md) [frag](docs/a.md#nope)\n[out](../x.md)',
			'docs/a.md': '# Yes',
		})).toEqual([
			'README.md:2: docs/reviews/gone.md: no tracked file or directory docs/reviews/gone.md',
			'README.md:2: docs/a.md#nope: no anchor #nope in docs/a.md',
			'README.md:3: ../x.md: points outside the repository',
		]);
	});

	it('ignores links in code spans and fenced blocks', () => {
		expect(run({ 'a.md': 'calls `RENDER[tab](#main)`\n```\n[x](missing.md)\n```\n' })).toEqual([]);
	});

	it('looks links up with / separators whatever the native path flavour is (Windows)', () => {
		expect(win32.sep).toBe('\\');
		expect(run({
			'README.md': '[dev](docs/development.md#setup) [up](docs/../docs/a/b.md) [dir](docs/a/)',
			'docs/development.md': '## Setup\n[back](../README.md) [sib](a/b.md)',
			'docs/a/b.md': '# B',
		})).toEqual([]);
	});
});
