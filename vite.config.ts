import { sveltekit } from '@sveltejs/kit/vite';
import type { Config } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { assertHostedGraph, selected, type HostedProfile } from './scripts/ci/hosted-imports.ts';
import { prepareHostedStaticInput } from './scripts/hosted-static-input.ts';
import { nativeRenderSdkBuild } from './scripts/native-render-sdk-build.ts';

// One app, two artifacts, chosen by one build variable. Unset (or `local`), the build is the local pilot on adapter-node
// that `bun run --bun start` serves. `CLEARCASE_TARGET=hosted` (only through `bun run --bun build:hosted`) is the
// Workers artifact on adapter-cloudflare: the hosted hooks and route tree that deploy/client/hosted-files.json selects,
// checked by the hosted import guard before the build starts.
const target = process.env.CLEARCASE_TARGET ?? 'local';
if (target !== 'local' && target !== 'hosted') throw new Error(`CLEARCASE_TARGET must be local or hosted, not ${target}`);
const hosted = target === 'hosted';
// The hosted profile is a test variable: `production` (the default) holds no test double; `hosted-gate` swaps in the
// gate's hooks and their named doubles (src/lib/server/runtime/hosted/gate/), for GRS-138's hosted gate only.
const profile = (process.env.CLEARCASE_HOSTED_PROFILE ?? 'production') as HostedProfile;
if (profile !== 'production' && profile !== 'hosted-gate') throw new Error(`CLEARCASE_HOSTED_PROFILE must be production or hosted-gate, not ${profile}`);
if (!hosted && process.env.CLEARCASE_HOSTED_PROFILE) throw new Error('CLEARCASE_HOSTED_PROFILE applies to CLEARCASE_TARGET=hosted only');
const adapter = hosted
	? (await import('@sveltejs/adapter-cloudflare')).default({ config: 'deploy/client/wrangler.toml' })
	: (await import('@sveltejs/adapter-node')).default();

const config: Config = {
	adapter,
	...(hosted ? { files: selected(process.cwd(), profile) } : {}),
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

export default defineConfig(async ({ command, isPreview }) => {
	// Prepare before sveltekit(config), not buildStart: Kit must discover these files in its own manifest.
	// Dev, preview and the local target retain their original static input.
	const input = hosted && command === 'build' && !isPreview ? prepareHostedStaticInput(process.cwd()) : undefined;
	try {
		const kit = await sveltekit(input ? { ...config, files: { ...config.files, assets: input.assets } } : config);
		return {
			// The build stamp `build:hosted` passes in; the runtime refuses an artifact without one.
			define: {
				...(hosted ? { __CLEARCASE_BUILD__: JSON.stringify(process.env.CLEARCASE_BUILD_STAMP ?? null) } : {}),
				// Public, reviewed build-input metadata, never an env/config/secret claim. No public manifest file.
				__CLEARCASE_PDF_ASSETS__: JSON.stringify(hosted && profile === 'production' ? input?.inventory ?? null : null)
			},
			plugins: [
				{ name: 'clearcase-hosted-boundary', buildStart() { if (hosted) assertHostedGraph(process.cwd(), profile); } },
				nativeRenderSdkBuild({ root: process.cwd(), target, profile }),
				kit,
				...(input ? [{
					name: 'clearcase-hosted-static-input',
					// Kit 3's adapter runs in an awaited post buildApp hook. Stay after it.
					// closeBundle is too early: individual environment builds also close their bundles.
					buildApp: { order: 'post' as const, sequential: true, handler() { input.dispose(); } },
					buildEnd(error?: Error) { if (error) input.dispose(); }
				}] : [])
			]
		};
	} catch (error) { input?.dispose(); throw error; }
});
