import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The Workers Vitest pool over the probe app's local config (GRS-107 P5): the probe runs it under Node and under Bun.
export default defineConfig({ plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })], test: { include: ['workers/*.test.js'] } });
