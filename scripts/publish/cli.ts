// The operator's publication CLI (sprint ticket 06). docs/sprint/runbooks/06-publish.md has the steps in order.
//
//   bun scripts/publish/cli.ts build    --package <dir> --case-folder <dir> --case-id <id> --out <dir>
//   bun scripts/publish/cli.ts upload   --out <dir> [--remote cc-staging:clearcase-staging-files]
//   bun scripts/publish/cli.ts register --out <dir> [--config deploy/staging/wrangler.jsonc] [--acknowledged-missing <n>]
//   bun scripts/publish/cli.ts signoff  --out <dir> --signer <email> --ack <CODE>=<reason>... [--config ...]
//   bun scripts/publish/cli.ts publish  --out <dir> [--config ...] [--remote ...]
//   bun scripts/publish/cli.ts grant    --case-id <id> --email <x+clerk_test@...> --credentials <file> [--config ...]
//
// `<out>` holds case content (the shards and register.json): keep it under `.local/`.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { build, recordPath, shardsOut } from './build.ts';
import { wranglerD1 } from './d1.ts';
import { publish, register } from './publish.ts';
import { signoff } from './signoff.ts';
import type { BuildRecord } from './types.ts';
import { remoteManifest, upload } from './upload.ts';

const CONFIG = 'deploy/staging/wrangler.jsonc';
const REMOTE = 'cc-staging:clearcase-staging-files';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    package: { type: 'string' }, 'case-folder': { type: 'string' }, 'case-id': { type: 'string' }, out: { type: 'string' },
    remote: { type: 'string', default: REMOTE }, config: { type: 'string', default: CONFIG }, 'acknowledged-missing': { type: 'string', default: '0' },
    signer: { type: 'string' }, ack: { type: 'string', multiple: true, default: [] }, email: { type: 'string' }, credentials: { type: 'string' },
  },
});
const need = (name: keyof typeof values): string => {
  const v = values[name];
  if (typeof v !== 'string' || !v) throw new Error(`--${name} is required`);
  return v;
};
const record = async (): Promise<BuildRecord> => JSON.parse(await readFile(recordPath(need('out')), 'utf8')) as BuildRecord;
const at = () => new Date().toISOString();

async function main(cmd: string | undefined) {
  switch (cmd) {
    case 'build': {
      const b = await build({ packageDir: need('package'), caseFolder: need('case-folder'), caseId: need('case-id'), out: need('out') });
      console.log(`built ${b.manifest.shards.length} shards for ${b.record.resultsVersion}: ${b.manifest.counts.documents} documents, ${b.manifest.counts.listPages} list pages`);
      console.log(`shard manifest sha256 ${b.manifestSha256}`);
      return;
    }
    case 'upload': {
      const r = await record();
      upload({ dir: shardsOut(need('out')), remote: need('remote'), resultsVersion: r.resultsVersion });
      console.log(`uploaded and checked ${r.resultsVersion} shards at ${need('remote')}`);
      return;
    }
    case 'register': {
      const r = await record();
      const acknowledgedMissing = Number(need('acknowledged-missing'));
      if (!Number.isInteger(acknowledgedMissing) || acknowledgedMissing < 0) throw new Error('--acknowledged-missing must be a whole number');
      await register(wranglerD1(need('config')), r, { at: at(), acknowledgedMissing });
      console.log(`registered ${r.resultsVersion} for ${r.caseId}: stored, shard manifest ${r.shardManifestSha256}`);
      return;
    }
    case 'signoff': {
      const r = await record();
      const acks = await signoff(wranglerD1(need('config')), r, { signer: need('signer'), acks: values.ack ?? [], at: at() });
      console.log(`signed off ${r.resultsVersion} (shard manifest ${r.shardManifestSha256}); acknowledged ${acks.map((a) => `${a.code}×${a.count}`).join(', ') || 'no warnings'}`);
      return;
    }
    case 'publish': {
      const r = await record();
      const p = await publish(wranglerD1(need('config')), r, { remoteManifest: remoteManifest({ remote: need('remote'), resultsVersion: r.resultsVersion }), at: at() });
      console.log(`published ${p.version_id} for ${r.caseId} at ${p.published_at}; previous ${p.previous_version_id ?? 'none'}`);
      return;
    }
    case 'grant': {
      const args = ['--config', need('config'), '--case-id', need('case-id'), '--email', need('email'), '--credentials', need('credentials')];
      const r = spawnSync('node', [path.join(import.meta.dirname, 'grant-remote.ts'), ...args], { stdio: 'inherit' });
      if (r.status !== 0) process.exit(r.status ?? 1);
      return;
    }
    default:
      throw new Error('usage: cli.ts build|upload|register|signoff|publish|grant (see the header of scripts/publish/cli.ts)');
  }
}

await main(positionals[0]).catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
