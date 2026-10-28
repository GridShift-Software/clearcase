// bun scripts/intake/grant.ts --config deploy/staging/wrangler.jsonc --case v5-demo --subject <id>
// Wrangler's remote binding runs under real Node, as the existing publication CLI does.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { D1 } from '../../src/lib/server/runtime/hosted/bindings.ts';
import { nativeDeployment } from '../publish/grant.ts';
import { provisionIntakeGrant } from './provision.ts';

async function main() {
  const { values } = parseArgs({ options: { config: { type: 'string' }, case: { type: 'string' }, subject: { type: 'string' } } });
  if (!values.config || !values.case || !values.subject) throw new Error('required arguments');
  if (process.versions.bun) {
    const result = spawnSync('node', [import.meta.filename, ...process.argv.slice(2)], { stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
    return;
  }
  const config = JSON.parse((await readFile(values.config, 'utf8')).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')) as {
    name: string; account_id: string; compatibility_date: string;
    vars: { CLEARCASE_NATIVE_CONFIG: string };
    d1_databases: { binding: string; database_id: string; database_name: string }[];
  };
  const { deployment } = nativeDeployment(config.vars.CLEARCASE_NATIVE_CONFIG);
  const binding = config.d1_databases.find((b) => b.binding === 'DB');
  // This one-off is staging-only. In particular, it cannot provision either frozen sandbox.
  if (config.name !== 'clearcase-staging' || deployment.worker !== config.name || deployment.clientId !== 'staging'
    || binding?.database_id !== deployment.d1DatabaseId || binding.database_name !== deployment.d1DatabaseName) throw new Error('not staging');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clearcase-intake-grant-'));
  try {
    const configPath = path.join(dir, 'wrangler.json');
    await writeFile(configPath, JSON.stringify({ name: 'clearcase-intake-grant', account_id: config.account_id,
      compatibility_date: config.compatibility_date, d1_databases: [{ ...binding, remote: true }] }));
    const { getPlatformProxy } = await import('wrangler');
    const proxy = await getPlatformProxy<{ DB: D1 }>({ configPath, remoteBindings: true, persist: false });
    try {
      const result = await provisionIntakeGrant({ db: proxy.env.DB, nativeConfig: config.vars.CLEARCASE_NATIVE_CONFIG,
        caseId: values.case, subject: values.subject });
      if (result.kind !== 'applied') throw new Error('grant not applied');
      console.log(`intake grant: ${result.repeated ? 'already applied' : 'applied'}, audit confirmed`);
    } finally { await proxy.dispose(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

main().catch(() => {
  // Provider errors may carry credentials or request details. Never print them.
  console.error('intake grant failed: verify staging configuration, existing credentials, case, subject and audit availability; retry the same command');
  process.exitCode = 1;
});
