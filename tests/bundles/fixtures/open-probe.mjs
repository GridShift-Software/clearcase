// Opens the PDF at argv[2] with the builder's engine and prints {ok, pages} or {ok:false, message} (run by pdf.test.ts in a
// child process, so a loop that never ends is stopped by the parent's timeout instead of freezing the test worker).
import { readFileSync } from 'node:fs';
import { open } from '../../../src/lib/bundles/pdf/index.ts';

try {
	const d = await open(new Uint8Array(readFileSync(process.argv[2])));
	console.log(JSON.stringify({ ok: true, pages: d.pages().length }));
} catch (e) {
	console.log(JSON.stringify({ ok: false, message: e instanceof Error ? e.message : String(e) }));
}
