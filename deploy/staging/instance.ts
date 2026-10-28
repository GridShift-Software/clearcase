// Which Clerk instance staging uses (GRS-267). Runbook: docs/sprint/runbooks/09c-clerk-instance.md. The non-secret values of
// each instance live in deploy/staging/clerk-instances/<mode>.json; this module checks a profile, rewrites the Clerk values
// of deploy/staging/wrangler.jsonc to match it, and finds the secrets that go with it. Never prints a value: plans name
// variables and secrets only. scripts/clerk-instance.sh drives it; deploy/staging/clerk.ts reads the active profile.
//
//   bun deploy/staging/instance.ts active          the profile wrangler.jsonc matches now
//   bun deploy/staging/instance.ts plan <mode>     what applying <mode> would change; exits 1 when it would refuse
//   bun deploy/staging/instance.ts write <mode>    rewrite wrangler.jsonc to <mode> (refuses like plan)
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { accountsPortalHost, frontendApiHost } from '../../src/lib/auth/clerk/config.ts';

const root = path.resolve(import.meta.dirname, '../..');
const CONFIG = path.join(root, 'deploy/staging/wrangler.jsonc');
export const MODES = ['development', 'production'] as const;
export type Mode = (typeof MODES)[number];
type Kind = 'client' | 'staff';
interface InstanceValues { publishableKey: string; frontendApi: string; signInUrl: string }
export interface Profile { mode: Mode; note: string; secretsFile: string; client: InstanceValues; staff: InstanceValues }

export function isMode(value: unknown): value is Mode {
	return (MODES as readonly unknown[]).includes(value);
}

export function loadProfile(mode: Mode): Profile {
	const file = path.join(root, `deploy/staging/clerk-instances/${mode}.json`);
	const p = JSON.parse(readFileSync(file, 'utf8')) as Profile;
	const text = (v: unknown) => typeof v === 'string' && v !== '';
	if (p.mode !== mode || !text(p.secretsFile) || p.secretsFile.includes('/') || !(['client', 'staff'] as const).every((k) => text(p[k]?.publishableKey) && text(p[k]?.frontendApi) && text(p[k]?.signInUrl)))
		throw new Error(`${path.relative(root, file)} is not a profile of mode ${mode}`);
	return p;
}

/** Why applying this profile would be refused, as lines naming fields and never values; empty when it is sound. */
export function problems(p: Profile): string[] {
	const placeholders = (['client', 'staff'] as const).flatMap((k) => (Object.keys(p[k]) as (keyof InstanceValues)[]).filter((f) => p[k][f].includes('PLACEHOLDER')).map((f) => `${k}.${f} is still a PLACEHOLDER`));
	if (placeholders.length) return placeholders;
	const out: string[] = [];
	const prefix = p.mode === 'production' ? 'pk_live_' : 'pk_test_';
	for (const k of ['client', 'staff'] as const) {
		const v = p[k];
		if (!v.publishableKey.startsWith(prefix)) out.push(`${k}.publishableKey is not a ${prefix} key`);
		const host = frontendApiHost(v.publishableKey);
		if (host === null) out.push(`${k}.publishableKey is not a Clerk publishable key`);
		else if (host !== v.frontendApi) out.push(`${k}.frontendApi is not the Frontend API host of ${k}.publishableKey`);
		let portal: string | null = null;
		try {
			const u = new URL(v.signInUrl);
			portal = u.protocol === 'https:' && u.pathname === '/sign-in' && !u.search && !u.hash ? u.hostname : null;
		} catch { /* reported below */ }
		if (portal === null) out.push(`${k}.signInUrl is not an https .../sign-in URL`);
		else if (host !== null && accountsPortalHost(host) !== null && accountsPortalHost(host) !== portal) out.push(`${k}.signInUrl is not on the accounts portal of ${k}.publishableKey`);
	}
	if (p.client.publishableKey === p.staff.publishableKey || p.client.frontendApi === p.staff.frontendApi) out.push('client and staff must be separate Clerk instances');
	return out;
}

const COUNTS = { pk: 2, signIn: 2, issuer: 1 };
/** `text` (wrangler.jsonc) with every Clerk value of `p` in place: both `vars` blocks and the issuers inside CLEARCASE_NATIVE_CONFIG. */
export function rewrite(text: string, p: Profile): string {
	let out = text;
	const swap = (re: RegExp, value: string, expected: number, what: string) => {
		let n = 0;
		out = out.replace(re, (_m, a: string, b: string) => { n++; return a + value + b; });
		if (n !== expected) throw new Error(`wrangler.jsonc has ${n} ${what}, expected ${expected}`);
	};
	for (const k of ['client', 'staff'] as const) {
		const K = k.toUpperCase();
		swap(new RegExp(`("CLERK_${K}_PUBLISHABLE_KEY":\\s*")[^"]*(")`, 'g'), p[k].publishableKey, COUNTS.pk, `CLERK_${K}_PUBLISHABLE_KEY entries`);
		swap(new RegExp(`("CLERK_${K}_SIGN_IN_URL":\\s*")[^"]*(")`, 'g'), p[k].signInUrl, COUNTS.signIn, `CLERK_${K}_SIGN_IN_URL entries`);
		// Inside the CLEARCASE_NATIVE_CONFIG string the quotes are escaped.
		swap(new RegExp(`(\\\\"${k}Issuer\\\\":\\\\")[^\\\\"]*(\\\\")`, 'g'), `https://${p[k].frontendApi}`, COUNTS.issuer, `${k}Issuer entries in CLEARCASE_NATIVE_CONFIG`);
	}
	return out;
}

const readConfig = () => readFileSync(CONFIG, 'utf8');
/** The sound profile wrangler.jsonc already matches in every Clerk value, or null (a hand-edited or half-switched file). */
export function activeProfile(text = readConfig()): Profile | null {
	for (const mode of MODES) {
		const p = loadProfile(mode);
		if (problems(p).length === 0 && rewrite(text, p) === text) return p;
	}
	return null;
}

function commonDir(): string {
	return path.dirname(spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).stdout.trim());
}
/** The env file holding the secret keys of a profile: STAGING_CLERK_ENV, else `.local/secrets/<secretsFile>` in the main checkout. */
export const secretsFile = (p: Profile) => process.env.STAGING_CLERK_ENV ?? path.join(commonDir(), '.local/secrets', p.secretsFile);

/**
 * The secret keys for a profile: the repo-secret variables STAGING_CLERK_SECRET_KEY and STAGING_CLERK_STAFF_SECRET_KEY,
 * else the profile's env file (CLERK_SECRET_KEY, CLERK_STAFF_SECRET_KEY). Refuses keys of the other mode.
 */
export function secretKeys(p: Profile): Record<Kind, string> {
	let client = process.env.STAGING_CLERK_SECRET_KEY, staff = process.env.STAGING_CLERK_STAFF_SECRET_KEY;
	if (!client || !staff) {
		const file = secretsFile(p);
		if (!existsSync(file)) throw new Error(`no Clerk keys for ${p.mode}: set STAGING_CLERK_SECRET_KEY and STAGING_CLERK_STAFF_SECRET_KEY, or STAGING_CLERK_ENV (${file} is missing)`);
		const env = Object.fromEntries(readFileSync(file, 'utf8').split('\n').map((l) => /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter((m) => m !== null).map((m) => [m[1], m[2].replace(/^(["'])(.*)\1$/, '$2')]));
		client ||= env.CLERK_SECRET_KEY;
		staff ||= env.CLERK_STAFF_SECRET_KEY;
	}
	const prefix = p.mode === 'production' ? 'sk_live_' : 'sk_test_';
	if (!client?.startsWith('sk_') || !staff?.startsWith('sk_')) throw new Error('the Clerk secret keys are missing or not sk_ keys');
	if (!client.startsWith(prefix) || !staff.startsWith(prefix)) throw new Error(`the Clerk secret keys are not ${prefix} keys, which the ${p.mode} profile needs (the other mode's keys are set in the environment or the keys file)`);
	return { client, staff };
}

const VARS = ['CLERK_CLIENT_PUBLISHABLE_KEY', 'CLERK_STAFF_PUBLISHABLE_KEY', 'CLERK_CLIENT_SIGN_IN_URL', 'CLERK_STAFF_SIGN_IN_URL'];
/** The plan to use `mode`, as lines with variable and secret names only, and whether applying it would be refused. */
export function plan(mode: Mode, text = readConfig()): { lines: string[]; refused: boolean } {
	const p = loadProfile(mode);
	const bad = problems(p);
	const current = activeProfile(text)?.mode ?? 'none (hand-edited)';
	const lines = [`use "${mode}" (wrangler.jsonc now matches: ${current}); profile deploy/staging/clerk-instances/${mode}.json`];
	if (bad.length) return { lines: [...lines, `REFUSED, the profile is not sound:`, ...bad.map((b) => `  ${b}`)], refused: true };
	const next = rewrite(text, p);
	const changed = (name: string) => (changedVar(name, text, next) ? 'change' : 'unchanged');
	lines.push('vars in wrangler.jsonc (top level and previews):', ...VARS.map((v) => `  ${v}: ${changed(v)}`),
		`  CLEARCASE_NATIVE_CONFIG (manifest.staffIssuer, manifest.clients[0].clientIssuer): ${changed('Issuer')}`);
	let source: string;
	try {
		secretKeys(p);
		source = `found, ${p.mode} keys`;
	} catch (e) {
		source = `NOT READY: ${e instanceof Error ? e.message : String(e)}`;
	}
	lines.push('secrets (Worker and Preview base config):',
		...['CLERK_CLIENT_SECRET_KEY', 'CLERK_STAFF_SECRET_KEY'].map((s) => `  ${s}: put from ${process.env.STAGING_CLERK_ENV ? 'STAGING_CLERK_ENV' : `.local/secrets/${p.secretsFile}`} (${source})`),
		...['CLERK_CLIENT_JWT_KEY', 'CLERK_STAFF_JWT_KEY'].map((s) => `  ${s}: refreshed from the instance's /v1/jwks`));
	return { lines, refused: false };
}
// Whether the text of any line naming `needle` differs between the two files (values are compared, never printed).
function changedVar(needle: string, a: string, b: string): boolean {
	const la = a.split('\n'), lb = b.split('\n');
	return la.some((line, i) => line.includes(needle) && line !== lb[i]);
}

/** wrangler.jsonc as JSON: whole-line comments removed (a string value never starts a line with `//`). */
const parse = (text: string) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as { vars: Record<string, string>; previews: { vars: Record<string, string> } };

function write(mode: Mode) {
	const p = loadProfile(mode);
	const bad = problems(p);
	if (bad.length) throw new Error(`REFUSED, the ${mode} profile is not sound:\n${bad.map((b) => `  ${b}`).join('\n')}`);
	const next = rewrite(readConfig(), p);
	const c = parse(next);
	const native = JSON.parse(c.vars.CLEARCASE_NATIVE_CONFIG) as { manifest: { staffIssuer: string; clients: { clientIssuer: string }[] } };
	const ok = [c.vars, c.previews.vars].every((v) => v.CLERK_CLIENT_PUBLISHABLE_KEY === p.client.publishableKey && v.CLERK_STAFF_PUBLISHABLE_KEY === p.staff.publishableKey && v.CLERK_CLIENT_SIGN_IN_URL === p.client.signInUrl && v.CLERK_STAFF_SIGN_IN_URL === p.staff.signInUrl)
		&& native.manifest.staffIssuer === `https://${p.staff.frontendApi}` && native.manifest.clients.every((x) => x.clientIssuer === `https://${p.client.frontendApi}`);
	if (!ok) throw new Error('the rewritten wrangler.jsonc does not carry the profile; nothing written');
	if (next !== readConfig()) writeFileSync(CONFIG, next);
}

if (import.meta.main) {
	const [cmd, arg] = process.argv.slice(2);
	try {
		if (cmd === 'active') console.log(activeProfile()?.mode ?? 'none');
		else if ((cmd === 'plan' || cmd === 'write') && isMode(arg)) {
			if (cmd === 'write') write(arg);
			else {
				const { lines, refused } = plan(arg);
				console.log(lines.join('\n'));
				if (refused) process.exit(1);
			}
		} else throw new Error(`usage: bun deploy/staging/instance.ts active | plan|write ${MODES.join('|')}`);
	} catch (e) {
		console.error(`instance.ts: ${e instanceof Error ? e.message : String(e)}`);
		process.exit(1);
	}
}
