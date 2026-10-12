import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script, no declarations
import { anchors, check, slug } from '../../scripts/check-links.mjs';

const run = (files: Record<string, string>) => check(Object.keys(files), (f: string) => files[f]);

describe('check-links', () => {
	it('slugs headings as GitHub does', () => {
		expect(slug('Toolchain and commands')).toBe('toolchain-and-commands');
		expect(slug('`gate`: one command, [the plan](x.md)!')).toBe('gate-one-command-the-plan');
		expect([...anchors('# A\n## A\n<a id="here"></a>\n```\n# not a heading\n```\n')]).toEqual(['a', 'a-1', 'here']);
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
});
