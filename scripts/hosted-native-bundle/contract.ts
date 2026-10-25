// The native final-bundle build contract (NATIVE24): the one reproducible way to turn the real SvelteKit production build
// (adapter-cloudflare 8.0.1 output in .svelte-kit/cloudflare) into the closed, prebundled native artifact that
// deploy/probes/target.ts stages: artifact/cloudflare/_worker.js (the one uploaded module) beside artifact/public/ (the
// public assets). Pure data: no filesystem, environment, process or network access; build.ts runs it.
//
// It reproduces the parent's measured credential-free protocol (worktree .local/native-production-artifact/bundle.sh at
// f8d2b7b3, receipt 223555Z): Wrangler 4.151.1 `deploy --dry-run --outdir` over a build-only config holding nothing but
// name, main, compatibility date and flags, send_metrics false and minify false; a fresh HOME/XDG/TMPDIR; an EXPLICIT
// environment (nothing inherited, so no ambient CLOUDFLARE_* or WRANGLER_* credential or override reaches Wrangler);
// `unshare -rn` with only loopback up. `--dry-run` never uploads; this contract never names the checked upload command.
// The compatibility flags are the reviewed target's, so the bundle is compiled for exactly the runtime it will run on
// (Wrangler's node-compat mode follows them), and target.ts then judges its dynamic host imports against those flags.
//
// Nothing here rewrites compiled code: the bundle's `_worker.js` bytes are copied unchanged, and the source map and the
// Wrangler README stay out of the artifact (their hashes are kept as provenance in the bundle record).

// Additive inputs.clientAssets records the digest of the sorted path/size/sha256 bindings read from Kit output/client.
// The used final-entry manifest and browser graph are checked as well; this record never grants public provenance.
export const NATIVE_BUNDLE_SCHEMA = 'clearcase.native-bundle/1';

/** The exact versions the contract was measured with; build.ts refuses a checkout whose installed packages differ (a new version is a reviewed change here). esbuild is Wrangler's own dependency. */
export const NATIVE_BUNDLE_PINS = Object.freeze({ wrangler: '4.151.1', esbuild: '0.28.2', '@sveltejs/adapter-cloudflare': '8.0.1', '@sveltejs/kit': '3.1.0', svelte: '5.57.2' });
export type NativeBundlePackage = keyof typeof NATIVE_BUNDLE_PINS;
export const NATIVE_BUNDLE_PACKAGES = Object.keys(NATIVE_BUNDLE_PINS) as NativeBundlePackage[];

/** Every reason the installed versions `found` are not the pinned ones. */
export function nativeBundleVersionProblems(found: Partial<Record<string, unknown>>): string[] {
	const problems: string[] = [];
	for (const k of NATIVE_BUNDLE_PACKAGES) if (found[k] !== NATIVE_BUNDLE_PINS[k]) problems.push(`${k} is ${found[k] === undefined ? 'not installed' : JSON.stringify(found[k])}, not the pinned ${NATIVE_BUNDLE_PINS[k]} the native bundle contract was measured with`);
	for (const k of Object.keys(found)) if (!(NATIVE_BUNDLE_PACKAGES as string[]).includes(k)) problems.push(`${k} is not a package the native bundle contract pins`);
	return problems;
}

/** The only Node the contract runs Wrangler with (Wrangler is hosted by Node, ADR 0008); its version is recorded, not pinned. */
export const NATIVE_BUNDLE_NODE = '/usr/bin/node';
/** The isolation wrapper: a new user and network namespace with only loopback up (the measured protocol). */
export const NATIVE_BUNDLE_ISOLATION = ['/usr/bin/unshare', '-rn', '/bin/sh', '-c', '/usr/bin/ip link set lo up && exec "$0" "$@"'] as const;

/** The work directory's layout: the build-only config, the Wrangler out directory, the assembled artifact and the bundle record are siblings, so the record and the map are never part of the artifact. */
export const nativeBundleLayout = (work: string) => ({
	home: `${work}/home`,
	cache: `${work}/cache`,
	config: `${work}/config`,
	tmp: `${work}/tmp`,
	configFile: `${work}/bundle-only.jsonc`,
	outdir: `${work}/bundle`,
	artifact: `${work}/artifact`,
	record: `${work}/native-bundle.json`,
});

/** The exact environment Wrangler receives, and nothing else. */
export const NATIVE_BUNDLE_ENV_KEYS = ['HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'TMPDIR', 'PATH', 'CI', 'WRANGLER_SEND_METRICS', 'WRANGLER_SEND_ERROR_REPORTS', 'WRANGLER_HIDE_BANNER', 'WRANGLER_LOG', 'CLOUDFLARE_CF_FETCH_ENABLED', 'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV', 'CLOUDFLARE_INCLUDE_PROCESS_ENV'] as const;
export function nativeBundleEnv(work: string): Record<(typeof NATIVE_BUNDLE_ENV_KEYS)[number], string> {
	const l = nativeBundleLayout(work);
	return {
		HOME: l.home,
		XDG_CACHE_HOME: l.cache,
		XDG_CONFIG_HOME: l.config,
		TMPDIR: l.tmp,
		PATH: '/usr/bin:/bin',
		CI: '1',
		WRANGLER_SEND_METRICS: 'false',
		WRANGLER_SEND_ERROR_REPORTS: 'false',
		WRANGLER_HIDE_BANNER: 'true',
		WRANGLER_LOG: 'log',
		CLOUDFLARE_CF_FETCH_ENABLED: 'false',
		CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
		CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
	};
}

/** The build-only Wrangler config: the adapter's worker as `main`, the reviewed target's compatibility date and flags, and nothing that names an account, binding, route or upload setting. */
export function nativeBundleConfig(a: { main: string; compatibilityDate: string; compatibilityFlags: readonly string[] }): string {
	return `${JSON.stringify({ name: 'clearcase-native-bundle-build', main: a.main, compatibility_date: a.compatibilityDate, compatibility_flags: [...a.compatibilityFlags], send_metrics: false, minify: false }, null, 2)}\n`;
}

/** The exact build-only command: the isolation wrapper, Node, the checkout's own pinned Wrangler, `deploy --dry-run --outdir`. */
export function nativeBundleArgv(a: { wrangler: string; work: string }): string[] {
	const l = nativeBundleLayout(a.work);
	return [...NATIVE_BUNDLE_ISOLATION, NATIVE_BUNDLE_NODE, a.wrangler, 'deploy', '--dry-run', '--config', l.configFile, '--outdir', l.outdir];
}

/** What Wrangler 4.151.1's `--outdir` holds after a build-only run: the bundle, its source map and a README. Anything else (a second module, a chunk, a wasm file) is refused: no_bundle uploads one module. */
export const NATIVE_BUNDLE_OUTDIR = ['README.md', '_worker.js', '_worker.js.map'] as const;
/** The adapter files that are not public assets: its unbundled worker and its .assetsignore, which must be exactly adapter-cloudflare 8.0.1's generate_assetsignore() output. */
export const ADAPTER_WORKER = '_worker.js';
export const ADAPTER_ASSETSIGNORE_FILE = '.assetsignore';
export const ADAPTER_ASSETSIGNORE = '\n_worker.js\n_routes.json\n_headers\n_redirects';
/** Adapter outputs the native profile does not carry: refused, never dropped silently. */
export const ADAPTER_REFUSED = ['_redirects', '_routes.json'] as const;
