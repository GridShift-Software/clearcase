// `cli.ts grant` runs this file under Node: wrangler's remote D1 binding hangs under Bun. It finds or creates the test
// user in the deployment's client Clerk app, writes the journeys' credentials file (0600, `.local/` only), and grants the
// user `viewer` on the case through grant.ts. Clerk keys are read from the environment or the owner's
// `.local/secrets/staging-clerk.env` and never printed.
//
//   node scripts/publish/grant-remote.ts --config deploy/staging/wrangler.jsonc --case-id v5-demo --email <x+clerk_test@...> --credentials <file>
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { D1 } from '../../src/lib/server/runtime/hosted/bindings.ts';
import { grantViewer } from './grant.ts';

const API = 'https://api.clerk.com/v1';
const TEST_CODE = '424242';
const root = path.resolve(import.meta.dirname, '../..');

function clientKey(): string {
  let key = process.env.STAGING_CLERK_SECRET_KEY;
  if (!key) {
    const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const file = process.env.STAGING_CLERK_ENV ?? path.join(path.dirname(common), '.local/secrets/staging-clerk.env');
    if (!existsSync(file)) throw new Error(`no Clerk key: set STAGING_CLERK_SECRET_KEY or STAGING_CLERK_ENV (${file} is missing)`);
    key = /^\s*CLERK_SECRET_KEY\s*=\s*["']?([^"'\s]+)/m.exec(readFileSync(file, 'utf8'))?.[1];
  }
  if (!key?.startsWith('sk_')) throw new Error('the client Clerk secret key is missing or not an sk_ key');
  return key;
}

async function clerk<T>(key: string, method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${p}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Clerk ${method} ${p.split('?')[0]}: ${res.status}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** The Clerk user id for `email`, created with `password` if absent; an existing user gets `password` set. */
async function testUser(email: string, password: string): Promise<string> {
  const key = clientKey();
  const found = await clerk<{ id: string }[]>(key, 'GET', `/users?email_address=${encodeURIComponent(email)}`);
  if (found.length > 1) throw new Error(`${found.length} Clerk users have ${email}`);
  if (found[0]) {
    await clerk(key, 'PATCH', `/users/${found[0].id}`, { password, skip_password_checks: true, sign_out_of_other_sessions: false });
    return found[0].id;
  }
  return (await clerk<{ id: string }>(key, 'POST', '/users', { email_address: [email], password, skip_password_checks: true })).id;
}

function stagingConfig(config: string) {
  const c = JSON.parse(readFileSync(config, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')) as {
    account_id: string; compatibility_date: string; vars: { CLEARCASE_NATIVE_CONFIG: string }; d1_databases: { binding: string; database_name: string; database_id: string }[];
  };
  return { accountId: c.account_id, date: c.compatibility_date, nativeConfig: c.vars.CLEARCASE_NATIVE_CONFIG, d1: c.d1_databases[0]! };
}

async function main() {
  const { values } = parseArgs({ options: { config: { type: 'string' }, 'case-id': { type: 'string' }, email: { type: 'string' }, credentials: { type: 'string' } } });
  if (!values.config || !values['case-id'] || !values.email || !values.credentials) throw new Error('usage: --config <wrangler.jsonc> --case-id <id> --email <email> --credentials <file>');
  if (!/\+clerk_test@/.test(values.email)) throw new Error('the email must be a +clerk_test address (Clerk test mode, code 424242)');
  const c = stagingConfig(values.config);

  let password: string;
  try { password = (JSON.parse(readFileSync(values.credentials, 'utf8')) as { email?: string; password?: string }).password ?? ''; } catch { password = ''; }
  if (password.length < 24) password = randomBytes(24).toString('base64url');
  const subject = await testUser(values.email, password);
  await mkdir(path.dirname(values.credentials), { recursive: true });
  await writeFile(values.credentials, JSON.stringify({ email: values.email, password, otp: TEST_CODE }), { mode: 0o600 });
  await chmod(values.credentials, 0o600);

  // A throwaway wrangler configuration holding only the remote D1 binding.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-grant-'));
  const configPath = path.join(dir, 'wrangler.json');
  await writeFile(configPath, JSON.stringify({ name: 'clearcase-publish-grant', account_id: c.accountId, compatibility_date: c.date,
    d1_databases: [{ binding: 'DB', database_name: c.d1.database_name, database_id: c.d1.database_id, remote: true }] }));
  const { getPlatformProxy } = await import('wrangler');
  const proxy = await getPlatformProxy<{ DB: D1 }>({ configPath, remoteBindings: true, persist: false });
  try {
    const r = await grantViewer({ db: proxy.env.DB, nativeConfig: c.nativeConfig, caseId: values['case-id'], subject });
    if (r.kind !== 'applied') throw new Error(`grant refused (${r.reason})`);
    console.log(`grant: viewer on ${values['case-id']} for ${values.email} (${subject}), grant ${r.grantId}${r.repeated ? ', already in place' : ''}`);
    console.log(`credentials: ${values.credentials}`);
  } finally {
    await proxy.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

await main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
