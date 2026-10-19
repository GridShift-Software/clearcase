import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Not vite.config.js: svelte-check in the root `check` loads the nearest vite.config.js for a .svelte file, and in a
// clone without this workspace's node_modules it could not. Under this name the root config covers the probe's page.

// The runner reads this line to prove which runtime hosted the build (Bun, not Node).
console.log('[probe build host]', JSON.stringify({ bun: process.versions.bun ?? null, node: process.versions.node }));

// PROBE_SOURCE_REVISION stamps the build: the Worker serves it as /_app/version.json, and the runner refuses a stamp that
// is not HEAD.
const revision = process.env.PROBE_SOURCE_REVISION;
if (!revision) throw new Error('PROBE_SOURCE_REVISION is not set: build through probe.ts, which stamps HEAD');

export default defineConfig({ plugins: [sveltekit({ adapter: adapter(), version: { name: revision } })] });
