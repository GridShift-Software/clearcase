// The one build of the Worker (GRS-111): probe.ts builds with it and evidence.ts rebuilds with it, so the committed
// artifact digest can be recomputed from a checkout with the same options.

/** The one Bun API these scripts use; the root project has no @types/bun. */
declare const Bun: {
	build(options: { entrypoints: string[]; outdir: string; target: 'browser'; format: 'esm'; define: Record<string, string> }): Promise<{ success: boolean; outputs: { path: string }[]; logs: unknown[] }>;
};

/** One self-contained ES module from `entry` into `outdir`, stamped with `sha` as PROBE_SOURCE_REVISION. */
export const buildWorker = (entry: string, outdir: string, sha: string) =>
	Bun.build({ entrypoints: [entry], outdir, target: 'browser', format: 'esm', define: { PROBE_SOURCE_REVISION: JSON.stringify(sha) } });
