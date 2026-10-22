// One proof run in its own process (GRS-107 cloud-run.test.ts): opens a run against the fake cloud, creates what argv
// names, then ends the way argv says, so the test can watch the exit trap tear down.
//   bun cloud-run-child.ts <manifests> <cloud> <exit|throw|wait> <kinds,...> [failing kinds]
import { openRun, type Kind } from '../../../../deploy/probes/cloud-run.ts';
import { fakeCloud } from './fake-cloud.ts';

const [manifests, cloud, end, kinds, failing] = process.argv.slice(2) as [string, string, string, string, string | undefined];
const list = kinds.split(',') as Kind[];
const run = openRun({ dir: manifests, ticket: '107', worker: 'w1', sha: 'abc1234def', kinds: ['r2', 'd1', 'worker'], provider: fakeCloud(cloud, (failing?.split(',') ?? []) as Kind[]) });
for (const kind of list) run.create(kind);
console.log(`created ${list.join(',')}`);
if (end === 'throw') throw new Error('synthetic failure after creating resources');
if (end === 'wait') setInterval(() => {}, 1000);
