import { sveltekit } from '@sveltejs/kit/vite';
import type { Config } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import hostedFiles from './deploy/client/hosted-files.json' with { type: 'json' };
import { assertHostedGraph } from './scripts/ci/hosted-imports.ts';

// One app, two artifacts, chosen by one build variable. Unset (or `local`), the build is the local pilot on adapter-node
// that `bun run --bun start` serves. `CLEARCASE_TARGET=hosted` (only through `bun run --bun build:hosted`) is the
// Workers artifact on adapter-cloudflare: the hosted hooks and route tree that deploy/client/hosted-files.json selects,
// checked by the hosted import guard before the build starts.
const target = process.env.CLEARCASE_TARGET ?? 'local';
if (target !== 'local' && target !== 'hosted') throw new Error(`CLEARCASE_TARGET must be local or hosted, not ${target}`);
const hosted = target === 'hosted';
const adapter = hosted
	? (await import('@sveltejs/adapter-cloudflare')).default({ config: 'deploy/client/wrangler.toml' })
	: (await import('@sveltejs/adapter-node')).default();

const config: Config = {
	adapter,
	...(hosted ? { files: hostedFiles } : {}),
	// Kit 3 removed $lib; the app's 541 imports keep it through this alias rather than a 135-file rename to #lib
	alias: { $lib: 'src/lib', '$lib/*': 'src/lib/*' },
	// a build of one exported revision gets that revision as its version name, so its client assets are reproducible
	...(process.env.CLEARCASE_SOURCE_REVISION ? { version: { name: process.env.CLEARCASE_SOURCE_REVISION } } : {}),
	// Strict CSP on the app origin; SvelteKit adds nonces/hashes for its own bootstrap script.
	csp: {
		mode: 'auto',
		directives: {
			'default-src': ['self'],
			'script-src': ['self'],
			// SvelteKit's route announcer carries one inline style attribute; allow exactly that hash.
			'style-src': ['self', 'unsafe-hashes', 'sha256-S8qMpvofolR8Mpjy4kQvEm7m1q8clzU4dfDH0AmvZjo='],
			'img-src': ['self'],
			'connect-src': ['self'],
			'object-src': ['none'],
			// the bundle builder previews its own built PDF (a blob: URL) in the page, as v5 does
			'frame-src': ['blob:'],
			'base-uri': ['none'],
			'form-action': ['self'],
			'frame-ancestors': ['none']
		}
	}
};

export default defineConfig({
	plugins: [{ name: 'clearcase-hosted-boundary', buildStart() { if (hosted) assertHostedGraph(process.cwd()); } }, sveltekit(config)]
});
