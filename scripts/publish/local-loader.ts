/** Run an unchanged local route loader over BuildContext.store, never the operator's app.
 * Usage: localLoad(ctx, 'analysis/matter').
 * Uses the pilot tests' __clearcase seam, restores it on failure, and serializes bindings.
 * Bun resolves local $lib imports here; Vitest already supplies that alias.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BuildContext } from './types.ts';

type BunPluginHost = { plugin(options: {
  name: string;
  setup(builder: { onLoad(options: { filter: RegExp }, load: (args: { path: string }) => { contents: string; loader: 'ts' } | undefined): void }): void;
}): void };
let aliasesInstalled = false;
let loading = false;
const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
function resolveAliases() {
  if (!process.versions.bun || aliasesInstalled) return;
  const { plugin }: BunPluginHost = createRequire(import.meta.url)('bun');
  plugin({ name: 'publish-local-loaders', setup(builder) {
    builder.onLoad({ filter: /\/src\/(routes|lib)\/.*\.ts$/ }, ({ path }) => {
      // Bun has no per-plugin disposal. Keep the registered hook inert outside a serialized load,
      // and restrict it to this checkout; never clear plugins installed by another caller.
      if (!loading || !path.startsWith(sourceRoot)) return;
      return {
        loader: 'ts',
        contents: readFileSync(path, 'utf8').replace(/(['"])\$lib\/([^'"]+)\1/g, (_match, quote: string, name: string) => {
          const base = fileURLToPath(new URL(`../../src/lib/${name}`, import.meta.url));
          const resolved = [`${base}.ts`, base].find(existsSync) ?? base;
          return `${quote}${resolved}${quote}`;
        }),
      };
    });
  } });
  aliasesInstalled = true;
}

let tail: Promise<unknown> = Promise.resolve();
export function localLoad<T = Record<string, unknown>>(ctx: Pick<BuildContext, 'store' | 'resultsVersion'>, route: string): Promise<T> {
  const run = tail.then(async () => {
    resolveAliases();
    // This is the existing app() seam used by tests/system/stores-21.test.ts.
    const g = globalThis as { __clearcase?: unknown };
    const previous = g.__clearcase;
    const additions = process.env.CLEARCASE_ANALYSIS_ADDITIONS;
    try {
      loading = true;
      g.__clearcase = { app: { store: ctx.store }, originals: null, id: 'publish', startedAt: '', build: null };
      process.env.CLEARCASE_ANALYSIS_ADDITIONS = '0';
      const v = ctx.store.getVersion(ctx.resultsVersion);
      if (!v) throw new Error('Local loader version is not imported');
      const url = new URL(`../../src/routes/v/[vid]/${route}/+page.server.ts`, import.meta.url);
      const { load } = await import(url.href) as { load: (event: never) => T };
      return await load({ parent: async () => ({ version: { id: v.id, caseId: v.case_id, created: v.created, verdict: v.verdict, inputRevisionId: v.input_revision_id } }), params: { vid: v.id } } as never);
    } finally {
      loading = false;
      if (previous === undefined) delete g.__clearcase; else g.__clearcase = previous;
      if (additions === undefined) delete process.env.CLEARCASE_ANALYSIS_ADDITIONS; else process.env.CLEARCASE_ANALYSIS_ADDITIONS = additions;
    }
  });
  tail = run.catch(() => {});
  return run;
}
