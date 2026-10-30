// GRS-250: lists the stored originals with their real R2 ETags, in the shape `manifest.ts --lsjson` reads. rclone's own
// listing cannot supply this: for a multipart object it reports an md5 from metadata, not the composite ETag R2 compares
// in a conditional read. The S3 credentials are read in memory from the operator's rclone remote and never printed.
//   bun scripts/originals/etags.ts --remote cc-staging --bucket clearcase-staging-files --out FILE
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

type Page = { contents?: Array<{ key: string; eTag?: string; size?: number }>; isTruncated?: boolean; nextContinuationToken?: string };
// Bun's built-in S3 client; the repository carries no Bun type definitions.
const { S3Client } = (globalThis as unknown as { Bun: { S3Client: new (o: Record<string, string>) => { list(o: Record<string, unknown>): Promise<Page> } } }).Bun;

const SHA_KEY = /^orig\/([0-9a-f]{64})$/;

export interface Listed { Path: string; Size: number; Metadata: { etag: string } }

export async function listEtags(list: (continuationToken?: string) => Promise<Page>): Promise<Listed[]> {
  const out: Listed[] = [];
  let token: string | undefined;
  do {
    const page = await list(token);
    for (const o of page.contents ?? []) {
      const m = SHA_KEY.exec(o.key);
      if (m && o.eTag && typeof o.size === 'number') out.push({ Path: m[1]!, Size: o.size, Metadata: { etag: o.eTag.replace(/^"|"$/g, '') } });
    }
    token = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (token);
  return out;
}

if (import.meta.main) {
  try {
    const v = new Map<string, string>();
    for (let i = 2; i < process.argv.length; i += 2) v.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '');
    const [remote, bucket, out] = ['remote', 'bucket', 'out'].map((k) => v.get(k) ?? (() => { throw new Error(`usage: bun scripts/originals/etags.ts --remote NAME --bucket NAME --out FILE (missing --${k})`); })()) as [string, string, string];
    const dump = spawnSync('rclone', ['config', 'dump'], { encoding: 'utf8' });
    const cfg = (JSON.parse(dump.stdout) as Record<string, Record<string, string>>)[remote];
    if (!cfg?.access_key_id || !cfg.secret_access_key || !cfg.endpoint) throw new Error(`rclone remote ${remote} has no S3 credentials or endpoint`);
    const s3 = new S3Client({ accessKeyId: cfg.access_key_id, secretAccessKey: cfg.secret_access_key, endpoint: cfg.endpoint, bucket, region: 'auto' });
    const listed = await listEtags((continuationToken) => s3.list({ prefix: 'orig/', maxKeys: 1000, continuationToken }));
    await writeFile(out, JSON.stringify(listed));
    console.log(`${listed.length} objects listed with ETags`);
  } catch (e) { console.error(`error: ${(e as Error).message}`); process.exit(2); }
}
