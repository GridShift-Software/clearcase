import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
export default {
	kit: {
		adapter: adapter(),
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
				'frame-src': ['none'],
				'base-uri': ['none'],
				'form-action': ['self'],
				'frame-ancestors': ['none']
			}
		},
		typescript: {
			// One project for `tsc --noEmit -p .` and svelte-check: the app plus the GRS-10 library, its scripts and tests.
			config: (config) => {
				config.include.push('../scripts/**/*.ts', '../vitest.config.ts');
				config.exclude = [...(config.exclude ?? []), '../tests/acceptance/**', '../build/**'];
				return config;
			}
		}
	}
};
