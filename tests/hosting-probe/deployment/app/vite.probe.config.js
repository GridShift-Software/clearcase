import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The deployment probe's Kit 3 app (GRS-107), built in a scratch copy under .local/ so cf, Wrangler and Void write
// nothing into the tree. Not vite.config.js, for the reason in ../../runtime/vite.probe.config.js.
console.log('[probe build host]', JSON.stringify({ bun: process.versions.bun ?? null, node: process.versions.node }));
export default defineConfig({ plugins: [sveltekit({ adapter: adapter({ config: 'wrangler.jsonc' }) })] });
