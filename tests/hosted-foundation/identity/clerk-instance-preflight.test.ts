// The secret preflight of the Clerk instance switch (GRS-267 fix round): missing, malformed, placeholder, identical and
// wrong-mode secret inputs refuse the switch in the plan, in the dry run and in apply, before wrangler.jsonc is written or
// anything is committed. Runs the real scripts/clerk-instance.sh and deploy/staging/instance.ts in a throwaway Git repository
// whose `src` links to this one and whose production profile is sound and SYNTHETIC; no real key, host or instance.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repo = path.resolve(import.meta.dirname, '../../..');
const key = (mode: 'live' | 'test', tail: string) => ['sk', mode, tail].join('_');
const pk = (host: string) => ['pk', 'live', Buffer.from(`${host}$`).toString('base64')].join('_');
const GOOD_CLIENT = key('live', 'Ab12Cd34Ef56Gh78Ij90Kl12'), GOOD_STAFF = key('live', 'Mn34Op56Qr78St90Uv12Wx34');
const profile = {
	mode: 'production', note: 'synthetic', secretsFile: 'staging-clerk-production.env',
	client: { publishableKey: pk('clerk.demo-a.example'), frontendApi: 'clerk.demo-a.example', signInUrl: 'https://accounts.demo-a.example/sign-in' },
	staff: { publishableKey: pk('clerk.demo-b.example'), frontendApi: 'clerk.demo-b.example', signInUrl: 'https://accounts.demo-b.example/sign-in' },
};

let dir: string;
const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.test' } });
const config = () => readFileSync(path.join(dir, 'deploy/staging/wrangler.jsonc'), 'utf8');
function run(args: string[], secrets: { env?: Record<string, string>; file?: string } = {}) {
	const env: Record<string, string | undefined> = { ...process.env, ...secrets.env };
	for (const name of ['STAGING_CLERK_SECRET_KEY', 'STAGING_CLERK_STAFF_SECRET_KEY', 'STAGING_CLERK_ENV']) if (!secrets.env || !(name in secrets.env)) delete env[name];
	const file = path.join(dir, '.local/secrets/staging-clerk-production.env');
	rmSync(file, { force: true });
	if (secrets.file !== undefined) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, secrets.file); }
	return spawnSync('bash', [...args], { cwd: dir, encoding: 'utf8', env });
}

beforeAll(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), 'clerk-instance-'));
	mkdirSync(path.join(dir, 'scripts'));
	mkdirSync(path.join(dir, 'deploy/staging/clerk-instances'), { recursive: true });
	copyFileSync(path.join(repo, 'scripts/clerk-instance.sh'), path.join(dir, 'scripts/clerk-instance.sh'));
	for (const f of ['instance.ts', 'wrangler.jsonc', 'clerk-instances/development.json']) copyFileSync(path.join(repo, 'deploy/staging', f), path.join(dir, 'deploy/staging', f));
	writeFileSync(path.join(dir, 'deploy/staging/clerk-instances/production.json'), JSON.stringify(profile, null, '\t'));
	symlinkSync(path.join(repo, 'src'), path.join(dir, 'src'));
	writeFileSync(path.join(dir, '.gitignore'), '.local/\n');
	git('init', '-q');
	git('add', '-A');
	git('commit', '-q', '-m', 'base');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fileOf = (client: string, staff: string) => `CLERK_SECRET_KEY=${client}\nCLERK_STAFF_SECRET_KEY=${staff}\n`;
const bad: [string, { env?: Record<string, string>; file?: string }][] = [
	['no secrets anywhere', {}],
	['development secrets in the environment', { env: { STAGING_CLERK_SECRET_KEY: key('test', 'Ab12Cd34Ef56Gh78Ij90Kl12'), STAGING_CLERK_STAFF_SECRET_KEY: key('test', 'Mn34Op56Qr78St90Uv12Wx34') } }],
	['one development secret in the keys file', { file: fileOf(GOOD_CLIENT, key('test', 'Mn34Op56Qr78St90Uv12Wx34')) }],
	['a prefix-correct placeholder secret', { file: fileOf(key('live', 'PLACEHOLDERPLACEHOLDER'), GOOD_STAFF) }],
	['a placeholder in the environment', { env: { STAGING_CLERK_SECRET_KEY: GOOD_CLIENT, STAGING_CLERK_STAFF_SECRET_KEY: key('live', 'placeholder-staff') } }],
	['a malformed secret (too short)', { file: fileOf(GOOD_CLIENT, key('live', 'short')) }],
	['a malformed secret (not a key)', { file: fileOf('not-a-key', GOOD_STAFF) }],
	['one key missing from the keys file', { file: `CLERK_SECRET_KEY=${GOOD_CLIENT}\n` }],
	['the same key for client and staff', { file: fileOf(GOOD_CLIENT, GOOD_CLIENT) }],
];

describe('the switch refuses unusable secrets before it writes or commits anything', () => {
	it.each(bad)('%s', (_what, secrets) => {
		const before = { config: config(), head: git('rev-parse', 'HEAD').stdout };
		const dry = run(['scripts/clerk-instance.sh', '--use', 'production', '--dry-run'], secrets);
		expect(dry.status, dry.stderr).not.toBe(0);
		const apply = run(['scripts/clerk-instance.sh', '--use', 'production', '--no-deploy'], secrets);
		expect(apply.status, apply.stderr).not.toBe(0);
		const write = run(['-c', 'bun deploy/staging/instance.ts write production'], secrets);
		expect(write.status, write.stderr).not.toBe(0);
		expect(config()).toBe(before.config);
		expect(git('rev-parse', 'HEAD').stdout).toBe(before.head);
		expect(git('status', '--porcelain').stdout).toBe('');
		for (const out of [dry, apply, write]) for (const value of [GOOD_CLIENT, GOOD_STAFF]) expect(out.stdout + out.stderr).not.toContain(value);
	});
	it('goes through with usable secrets: the dry run exits 0 and writes nothing', () => {
		const head = git('rev-parse', 'HEAD').stdout, before = config();
		const dry = run(['scripts/clerk-instance.sh', '--use', 'production', '--dry-run'], { file: fileOf(GOOD_CLIENT, GOOD_STAFF) });
		expect(dry.status, dry.stderr).toBe(0);
		expect(dry.stderr).toContain('CLERK_CLIENT_PUBLISHABLE_KEY: change');
		expect(dry.stdout + dry.stderr).not.toContain(GOOD_CLIENT);
		expect(config()).toBe(before);
		expect(git('rev-parse', 'HEAD').stdout).toBe(head);
	});
	it('puts the Co-Authored-By trailer on the commit it makes', () => {
		// Stops after the commit: scripts/deploy-staging.sh is not in the throwaway repository.
		const apply = run(['scripts/clerk-instance.sh', '--use', 'production', '--no-deploy'], { file: fileOf(GOOD_CLIENT, GOOD_STAFF) });
		expect(apply.status).not.toBe(0);
		expect(git('log', '-1', '--format=%B').stdout).toMatch(/^Co-Authored-By: .+ <.+@.+>$/m);
	});
});
