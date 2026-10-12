#!/usr/bin/env bun
// `bun scripts/check-links.mjs` (part of `check`): every relative link and anchor in the tracked Markdown files must
// resolve. A link target must be a tracked file or a directory holding one (an ignored file is missing on a clean
// clone); a `#fragment` must name a heading (GitHub's slug) or an `id`/`name` attribute in the target Markdown file.
// Inline links, images and reference definitions count; links inside code spans and fenced blocks, URLs with a scheme
// and absolute paths do not. Prints one `file:line: link: problem` line per broken link and exits 1 when there is one.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export const slug = (heading) =>
	heading
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/<[^>]+>/g, '')
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, '')
		.replace(/\s/g, '-');

/** Lines outside fenced code blocks; each `{ n, raw, text }` keeps its 1-based line number, the line as written and the line with code spans blanked. */
function proseLines(text) {
	const out = [];
	let fence = null;
	text.split('\n').forEach((line, i) => {
		const open = line.match(/^\s*(`{3,}|~{3,})/);
		if (fence) {
			if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
		} else if (open) fence = open[1];
		else out.push({ n: i + 1, raw: line, text: line.replace(/(`+)(?:(?!\1).)+?\1/g, '') });
	});
	return out;
}

/** The anchors a Markdown file defines: heading slugs (duplicates get -1, -2, …) and explicit id/name attributes. */
export function anchors(text) {
	const seen = new Map();
	const out = new Set();
	for (const { raw, text: line } of proseLines(text)) {
		const h = raw.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
		if (h) {
			const base = slug(h[1]);
			const k = seen.get(base) ?? 0;
			seen.set(base, k + 1);
			out.add(k ? `${base}-${k}` : base);
		}
		for (const m of line.matchAll(/<[a-z]+[^>]*\s(?:id|name)="([^"]+)"/gi)) out.add(m[1]);
	}
	return out;
}

/** The link targets in a Markdown file, as `{ n, target }`. */
export function links(text) {
	const out = [];
	for (const { n, text: line } of proseLines(text)) {
		for (const m of line.matchAll(/!?\[(?:[^\]\\]|\\.)*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push({ n, target: m[1] });
		const def = line.match(/^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/);
		if (def) out.push({ n, target: def[1] });
	}
	return out;
}

/** Problems with the relative links in `files` (repo-relative tracked paths, always `/`-separated like `git ls-files`), read through `read`. Targets resolve with `path.posix`; native paths are only for reading files. */
export function check(files, read) {
	const tracked = new Set(files);
	const dirs = new Set(files.flatMap((f) => f.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
	const cache = new Map();
	const anchorsOf = (f) => cache.get(f) ?? cache.set(f, anchors(read(f))).get(f);
	const problems = [];
	for (const file of files.filter((f) => f.endsWith('.md'))) {
		for (const { n, target } of links(read(file))) {
			if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue;
			const [rawPath, fragment] = target.split('#', 2);
			let path;
			try {
				path = rawPath ? posix.normalize(posix.join(posix.dirname(file), decodeURIComponent(rawPath))).replace(/\/$/, '') : file;
			} catch {
				problems.push(`${file}:${n}: ${target}: cannot decode the path`);
				continue;
			}
			if (path.startsWith('..')) problems.push(`${file}:${n}: ${target}: points outside the repository`);
			else if (!tracked.has(path) && !dirs.has(path) && path !== '.') problems.push(`${file}:${n}: ${target}: no tracked file or directory ${path}`);
			else if (fragment !== undefined && tracked.has(path) && path.endsWith('.md') && !anchorsOf(path).has(decodeURIComponent(fragment))) problems.push(`${file}:${n}: ${target}: no anchor #${fragment} in ${path}`);
		}
	}
	return problems;
}

if (import.meta.main) {
	const ls = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' });
	if (ls.status !== 0) {
		console.error(`check-links: git ls-files failed: ${ls.stderr || ls.error?.message}`);
		process.exit(1);
	}
	const files = ls.stdout.split('\0').filter(Boolean);
	const problems = check(files, (f) => readFileSync(join(REPO, f), 'utf8'));
	for (const p of problems) console.error(p);
	console.log(`check-links: ${files.filter((f) => f.endsWith('.md')).length} Markdown files, ${problems.length} broken link(s)`);
	process.exit(problems.length ? 1 : 0);
}
