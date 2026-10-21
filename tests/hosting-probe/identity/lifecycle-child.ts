// A runner for gates.test.ts's process-lifecycle tests (GRS-108 M1): it starts a crafted world, prints the two ports its
// Workers listen on, and then ends the way argv[2] says: `exit` (process.exit), `throw` (an error that ends the module), or `wait`
// (the test sends it a signal). The test then asks whether serve.mjs and its workerd outlived it.
import { craftedWorld } from './crafted.ts';

const mode = process.argv[2];
const w = await craftedWorld({ reuseBuild: process.env.CRAFTED_SKIP_BUILD === '1' });
console.log(`world ${JSON.stringify({ ports: [new URL(w.origin.client).port, new URL(w.origin.staff).port].map(Number) })}`);
if (mode === 'exit') process.exit(0);
if (mode === 'throw') throw new Error('lifecycle: a crafted uncaught error');
await new Promise(() => {});
