// The operator's publication CLI (sprint ticket 06). docs/sprint/runbooks/06-publish.md has the steps in order.
//
//   bun scripts/publish/cli.ts build    --package <dir> --case-folder <dir> --case-id <id> --out <dir> [--family <name>]
//   bun scripts/publish/cli.ts upload   --out <dir> [--family <name>] [--remote cc-staging:clearcase-staging-files]
//   bun scripts/publish/cli.ts register --out <dir> [--config deploy/staging/wrangler.jsonc] [--acknowledged-missing <n>]
//   bun scripts/publish/cli.ts amend    --out <dir> --family <name> [--config ...]
//   bun scripts/publish/cli.ts signoff  --out <dir> --signer <email> --ack <CODE>=<reason>... [--family <name>] [--config ...]
//   bun scripts/publish/cli.ts publish  --out <dir> [--family <name>] [--config ...] [--remote ...]
//   bun scripts/publish/cli.ts grant    --case-id <id> --email <x+clerk_test@...> --credentials <file> [--config ...]
//
// A new version: build, upload, register, signoff, publish. One family added to a published version (tickets 12 to 15):
// build --family, upload --family, amend, signoff --family, publish --family, against the same --out.
// `<out>` holds case content (the shards and register.json): keep it under `.local/`.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { build, buildFamily, localAmendment, recordPath, shardsOut } from './build.ts';
import { wranglerD1 } from './d1.ts';
import { MANIFEST_NAME } from './manifest.ts';
import { amend, publish, publishAmendment, register } from './publish.ts';
import { signoff } from './signoff.ts';
import type { BuildRecord } from './types.ts';
import { rcloneRemote, upload } from './upload.ts';

const CONFIG = 'deploy/staging/wrangler.jsonc';
const REMOTE = 'cc-staging:clearcase-staging-files';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    package: { type: 'string' }, 'case-folder': { type: 'string' }, 'case-id': { type: 'string' }, out: { type: 'string' },
    remote: { type: 'string', default: REMOTE }, config: { type: 'string', default: CONFIG }, 'acknowledged-missing': { type: 'string', default: '0' },
    signer: { type: 'string' }, ack: { type: 'string', multiple: true, default: [] }, email: { type: 'string' }, credentials: { type: 'string' }, family: { type: 'string' },
  },
});
const need = (name: keyof typeof values): string => {
  const v = values[name];
  if (typeof v !== 'string' || !v) throw new Error(`--${name} is required`);
  return v;
};
const record = async (): Promise<BuildRecord> => JSON.parse(await readFile(recordPath(need('out')), 'utf8')) as BuildRecord;
const at = () => new Date().toISOString();
const family = values.family;
const remoteOf = (r: BuildRecord) => rcloneRemote({ remote: need('remote'), resultsVersion: r.resultsVersion });
const manifestBytes = async () => new Uint8Array(await readFile(path.join(shardsOut(need('out')), MANIFEST_NAME)));

async function main(cmd: string | undefined) {
  switch (cmd) {
    case 'build': {
      if (family) {
        const a = await buildFamily({ packageDir: need('package'), caseFolder: need('case-folder'), caseId: need('case-id'), out: need('out'), family });
        console.log(`built family ${family} for ${a.amendment.resultsVersion}: ${a.amendment.shards.length} shards, amendment ${a.sha256} of manifest ${a.amendment.parentManifestSha256}`);
        return;
      }
      const b = await build({ packageDir: need('package'), caseFolder: need('case-folder'), caseId: need('case-id'), out: need('out') });
      console.log(`built ${b.manifest.shards.length} shards for ${b.record.resultsVersion}: ${b.manifest.counts.documents} documents, ${b.manifest.counts.listPages} list pages`);
      console.log(`shard manifest sha256 ${b.manifestSha256}`);
      return;
    }
    case 'upload': {
      const r = await record();
      const index = family ? (await localAmendment(need('out'), family)).name : MANIFEST_NAME;
      const u = await upload({ dir: shardsOut(need('out')), index, remote: remoteOf(r) });
      console.log(`uploaded and checked ${index} of ${r.resultsVersion} at ${need('remote')}: ${u.created.length} objects created, the rest already there with these bytes`);
      return;
    }
    case 'register': {
      const r = await record();
      const acknowledgedMissing = Number(need('acknowledged-missing'));
      if (!Number.isInteger(acknowledgedMissing) || acknowledgedMissing < 0) throw new Error('--acknowledged-missing must be a whole number');
      await register(wranglerD1(need('config')), r, { at: at(), acknowledgedMissing, manifest: await manifestBytes() });
      console.log(`registered ${r.resultsVersion} for ${r.caseId}: stored and verified, shard manifest ${r.shardManifestSha256}`);
      return;
    }
    case 'amend': {
      const r = await record(), a = await localAmendment(need('out'), need('family'));
      const x = await amend(wranglerD1(need('config')), r, a.bytes, { at: at() });
      console.log(`registered amendment ${x.sha256} (${x.family}, ${x.shards} shards) of ${r.resultsVersion}; sign it off, then publish --family ${x.family}`);
      return;
    }
    case 'signoff': {
      const r = await record();
      const target = family ? (await localAmendment(need('out'), family)).sha256 : r.shardManifestSha256;
      const s = await signoff(wranglerD1(need('config')), r, { signer: need('signer'), acks: values.ack ?? [], at: at(), target });
      console.log(`${s.replayed ? 'already signed off, nothing new recorded' : 'signed off'}: ${r.resultsVersion} ${family ? `amendment ${target} (${family})` : `shard manifest ${target}`}, attestation ${s.id}; acknowledged ${s.acknowledgements.map((a) => `${a.code}×${a.count}`).join(', ') || 'no warnings'}`);
      console.log(`attested by ${s.signers.join(', ')}`);
      return;
    }
    case 'publish': {
      const r = await record();
      if (family) {
        const a = await localAmendment(need('out'), family);
        const p = await publishAmendment(wranglerD1(need('config')), r, { amendment: a.bytes, remote: await remoteOf(r).read(a.name), at: at() });
        console.log(`admitted amendment ${a.sha256} (${family}) into ${r.resultsVersion} at ${p.admittedAt}; the version serves ${p.served} shards`);
        return;
      }
      const p = await publish(wranglerD1(need('config')), r, { remoteManifest: await remoteOf(r).read(MANIFEST_NAME), at: at() });
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
      throw new Error('usage: cli.ts build|upload|register|amend|signoff|publish|grant (see the header of scripts/publish/cli.ts)');
  }
}

await main(positionals[0]).catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
