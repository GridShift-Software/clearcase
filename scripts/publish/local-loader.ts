/** Run an unchanged local route loader over BuildContext.store, never the operator's app.
 * Usage: localLoad(ctx, 'analysis/matter').
 * Uses the pilot tests' __clearcase seam, restores it on failure, and serializes bindings.
 * Bun resolves local $lib imports here; Vitest already supplies that alias.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BuildContext } from './types.ts';

let aliases: Promise<void> | undefined;
async function resolveAliases() {
  if (!process.versions.bun) return;
  await (aliases ??= (async () => {
    const { plugin }: { plugin: (p: { name: string; setup(builder: { onLoad(filter: { filter: RegExp }, load: (args: { path: string }) => { contents: string; loader: 'ts' }): void; onResolve(filter: { filter: RegExp }, resolve: (args: { path: string }) => { path: string }): void }): void }) => void } = createRequire(import.meta.url)('bun');
    plugin({ name: 'publish-local-loaders', setup(builder) {
      builder.onLoad({ filter: /\+page\.server\.ts$/ }, ({ path }) => ({
        loader: 'ts',
        contents: readFileSync(path, 'utf8').replace(/(['"])\$lib\/([^'"]+)\1/g, (_match, quote: string, name: string) => {
          const base = fileURLToPath(new URL(`../../src/lib/${name}`, import.meta.url));
          const resolved = [`${base}.ts`, base].find(existsSync) ?? base;
          return `${quote}${resolved}${quote}`;
        }),
      }));
      builder.onResolve({ filter: /^\$lib\// }, ({ path }) => {
        const base = fileURLToPath(new URL(`../../src/lib/${path.slice(5)}`, import.meta.url));
        return { path: [`${base}.ts`, `${base}/index.ts`, base].find(existsSync) ?? base };
      });
    } });
  })());
}

let tail: Promise<unknown> = Promise.resolve();
export function localLoad<T = Record<string, unknown>>(ctx: Pick<BuildContext, 'store' | 'resultsVersion'>, route: string): Promise<T> {
  const run = tail.then(async () => {
    await resolveAliases();
    // This is the existing app() seam used by tests/system/stores-21.test.ts.
    const g = globalThis as { __clearcase?: unknown };
    const previous = g.__clearcase;
    const additions = process.env.CLEARCASE_ANALYSIS_ADDITIONS;
    try {
      g.__clearcase = { app: { store: ctx.store }, originals: null, id: 'publish', startedAt: '', build: null };
      process.env.CLEARCASE_ANALYSIS_ADDITIONS = '0';
      const v = ctx.store.getVersion(ctx.resultsVersion);
      if (!v) throw new Error('Local loader version is not imported');
      const url = new URL(`../../src/routes/v/[vid]/${route}/+page.server.ts`, import.meta.url);
      const { load } = await import(url.href) as { load: (event: never) => T };
      return await load({ parent: async () => ({ version: { id: v.id, caseId: v.case_id, created: v.created, verdict: v.verdict, inputRevisionId: v.input_revision_id } }), params: { vid: v.id } } as never);
    } finally {
      if (previous === undefined) delete g.__clearcase; else g.__clearcase = previous;
      if (additions === undefined) delete process.env.CLEARCASE_ANALYSIS_ADDITIONS; else process.env.CLEARCASE_ANALYSIS_ADDITIONS = additions;
    }
  });
  tail = run.catch(() => {});
  return run;
}
