import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { assertHostedGraph } from './scripts/ci/hosted-imports.ts';

export default defineConfig({ plugins: [{ name: 'clearcase-hosted-boundary', buildStart() { if (process.env.CLEARCASE_TARGET === 'hosted-spike') assertHostedGraph(process.cwd()); } }, sveltekit()] });
