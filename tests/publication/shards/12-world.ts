// Sprint ticket 12's synthetic version: ticket 06's world plus an e-mail with two extracted attachments (one with its
// bytes, one whose file is not in the case folder), a document whose file is not supplied, and enough bulk rows for a
// bundle to span two list pages. Nothing here is a case.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCase, row } from '../../e2e/pilot/lib/fixtures.ts';
import { build, shardsOut } from '../../../scripts/publish/build.ts';
import { CASE_ID, shardFiles, type BuiltCase } from './world.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const now = () => new Date('2001-01-01T00:00:00Z');
/** Bulk documents beyond the synthetic base: 460, so a bundle of 230 spans two 200-row list pages with the base rows. */
export const BULK = 460;
export const KID_OK = 'KID-1', KID_GONE = 'KID-2', NO_FILE = 'GONE-1', PARENT = 'EM-0001';

export async function docCase(): Promise<BuiltCase> {
  const root = await mkdtemp(path.join(process.env.CLEARCASE_TEST_TMP ?? os.tmpdir(), 'cc-doc12-'));
  const originals: Record<string, Uint8Array> = { [`KIDS/${KID_OK} child.pdf`]: enc('%PDF-1.4\n% synthetic child\n%%EOF\n') }, rows = [];
  for (let i = 0; i < BULK; i++) {
    const file = `BULK/BK-${String(i).padStart(4, '0')} Synthetic.pdf`, bytes = enc(`%PDF-1.4\n% synthetic bulk ${i}\n%%EOF\n`);
    originals[file] = bytes;
    rows.push(row(`BK-${String(i).padStart(4, '0')}`, 1000 + i, file, bytes.byteLength, { date: `${2000 + (i % 5)}-01-0${1 + (i % 9)}`, bundle: i % 2 ? 'Bulk A' : 'Bulk B', doc_type: i % 3 ? 'letter' : 'invoice' }));
  }
  rows.push(
    row(KID_OK, 900, `KIDS/${KID_OK} child.pdf`, 30, { bundle: 'Kids', pr: PARENT, refs: [PARENT, 'BK-0001', 'ZZ-9999'] }),
    row(KID_GONE, 901, `KIDS/${KID_GONE} gone.pdf`, 5, { bundle: 'Kids', pr: PARENT }),
    row(NO_FILE, 902, `KIDS/${NO_FILE} gone.pdf`, 5, { bundle: 'Kids' }),
  );
  const synth = await buildCase(path.join(root, 'case'), { caseId: CASE_ID, originals, rows });
  const out = path.join(root, 'out');
  const built = await build({ packageDir: synth.pkgDir, caseFolder: synth.caseDir, caseId: CASE_ID, out, builder: { sha: 'test', bun: 'test' }, now });
  return { root, out, synth, built, files: await shardFiles(shardsOut(out)), cleanup: () => rm(root, { recursive: true, force: true }) };
}
