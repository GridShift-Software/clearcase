// Staging's London placement, for the deploy smoke in scripts/deploy-staging.sh (GRS-289). Runbook:
// docs/sprint/runbooks/02-staging.md. A response's `cf-placement: remote-LHR` is the direct observation that the Worker ran
// in London. Cloudflare may leave that header out (it may change before Placement leaves beta), so when it is absent the
// smoke asks Wrangler for the deployments and the active version instead. That proves what Cloudflare is configured to run,
// not where any one request ran, and the output says which of the two was shown.
//
//   bun scripts/staging-placement.ts header <headers-file>     `observed: …` or `absent: …`; any other cf-placement fails
//   bun scripts/staging-placement.ts active <deployments.json> the one version the newest deployment serves at 100%
//   bun scripts/staging-placement.ts provider <version> <sha> <deployments.json> <version.json>
//                                                              the placement summary, after every check below passes
//
// The JSON files are Wrangler's `deployments list --json` and `versions view <id> --json`. Only the fields checked here
// are read; nothing else (bindings included) is printed.
import { readFileSync } from 'node:fs';

export const HEADER = 'remote-LHR';
export const REGION = 'aws:eu-west-2';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const keysAre = (v: Json, keys: string[]) => Object.keys(v).sort().join() === [...keys].sort().join();
function fail(message: string): never {
	throw new Error(message);
}

/**
 * `observed: …` for exactly one `cf-placement: remote-LHR`, `absent: …` for none (naming the colo that took the request,
 * from `cf-ray`); any other value, an empty one or a second header contradicts London and throws.
 */
export function placementHeader(headers: string): string {
	const lines = headers.split(/\r?\n/), values = lines.filter((l) => /^cf-placement:/i.test(l)).map((l) => l.slice(l.indexOf(':') + 1).trim());
	if (values.length === 1 && values[0] === HEADER) return `observed: response execution observed (cf-placement ${HEADER})`;
	if (values.length > 0) fail(`cf-placement is ${values.map((v) => `'${v}'`).join(', ')}, not ${HEADER}`);
	const colo = lines.map((l) => /^cf-ray:\s*[0-9a-f]+-([A-Z]{3})\s*$/i.exec(l)?.[1]).find(Boolean);
	return `absent: response execution not observed (no cf-placement header; Cloudflare took the request at ${colo ?? 'an unnamed colo'})`;
}

/** The version the newest deployment serves to all traffic. A split, a stale or a malformed list throws. */
export function activeVersion(deployments: unknown): string {
	if (!Array.isArray(deployments) || deployments.length === 0) fail('the deployments list is empty or not a list');
	const dated = deployments.map((d, i) => {
		const at = isObject(d) && typeof d.created_on === 'string' ? Date.parse(d.created_on) : NaN;
		if (!Number.isFinite(at)) fail(`deployment ${i} has no valid created_on`);
		return { d: d as Json, at };
	});
	const newest = Math.max(...dated.map((x) => x.at)), top = dated.filter((x) => x.at === newest);
	if (top.length !== 1) fail('two deployments share the newest created_on; the active one is ambiguous');
	const versions = top[0].d.versions;
	if (!Array.isArray(versions) || versions.length !== 1) fail(`the newest deployment ${String(top[0].d.id)} serves ${Array.isArray(versions) ? versions.length : 'no'} versions, not exactly one`);
	const [v] = versions as unknown[];
	if (!isObject(v) || typeof v.version_id !== 'string' || v.version_id === '') fail('the newest deployment names no version_id');
	if (v.percentage !== 100) fail(`the newest deployment serves ${v.version_id} at ${String(v.percentage)}%, not 100%`);
	return v.version_id;
}

/**
 * The provider's word that `versionId`, tagged `sha`, serves all traffic with targeted placement in exactly London. Each
 * field Cloudflare reports is checked; an unknown key in the placement throws rather than being ignored.
 */
export function providerPlacement(versionId: string, sha: string, deployments: unknown, version: unknown): string {
	if (!/^[0-9a-f]{40}$/.test(sha)) fail(`'${sha}' is not a full SHA`);
	const active = activeVersion(deployments);
	if (active !== versionId) fail(`the active deployment serves ${active}, not ${versionId}`);
	if (!isObject(version) || version.id !== versionId) fail(`the version record is not ${versionId}`);
	const tag = isObject(version.annotations) ? version.annotations['workers/tag'] : undefined;
	if (tag !== sha) fail(`version ${versionId} is tagged '${String(tag ?? '')}', not ${sha}`);
	const script = isObject(version.resources) ? version.resources.script : undefined;
	if (!isObject(script) || !isObject(script.placement)) fail(`version ${versionId} reports no placement`);
	const p = script.placement;
	if (!keysAre(p, ['mode', 'target'])) fail(`version ${versionId} placement has keys ${Object.keys(p).join(', ')}, not mode and target`);
	if (p.mode !== 'targeted') fail(`version ${versionId} placement mode is '${String(p.mode)}', not targeted`);
	if ('placement_mode' in script && script.placement_mode !== 'targeted') fail(`version ${versionId} placement_mode is '${String(script.placement_mode)}', not targeted`);
	if (!Array.isArray(p.target) || p.target.length !== 1) fail(`version ${versionId} has ${Array.isArray(p.target) ? p.target.length : 'no'} placement targets, not one`);
	const [t] = p.target as unknown[];
	if (!isObject(t) || !keysAre(t, ['id', 'region', 'type'])) fail(`version ${versionId} placement target is not {id, region, type}`);
	if (t.type !== 'region' || t.region !== REGION) fail(`version ${versionId} targets ${String(t.type)} ${String(t.region)}, not region ${REGION}`);
	if (!Number.isInteger(t.id) || (t.id as number) <= 0) fail(`version ${versionId} placement target has no valid id`);
	return `provider configuration verified: version ${versionId} at 100%, tagged ${sha}, targeted placement region ${REGION} (target ${String(t.id)})`;
}

const readJson = (file: string): unknown => {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		fail(`${file} is not readable JSON`);
	}
};

if (import.meta.main) {
	const [cmd, ...a] = process.argv.slice(2);
	try {
		if (cmd === 'header' && a.length === 1) console.log(placementHeader(readFileSync(a[0], 'utf8')));
		else if (cmd === 'active' && a.length === 1) console.log(activeVersion(readJson(a[0])));
		else if (cmd === 'provider' && a.length === 4) console.log(providerPlacement(a[0], a[1], readJson(a[2]), readJson(a[3])));
		else fail('usage: staging-placement.ts header <file> | active <deployments.json> | provider <version> <sha> <deployments.json> <version.json>');
	} catch (e) {
		console.error((e as Error).message);
		process.exit(1);
	}
}
