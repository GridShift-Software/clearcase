// One Wrangler test-harness request against the built Worker (GRS-107 P3), run by the probe under Node and under Bun.
// It creates the notes table through the harness's own binding, then asks /api/health through the harness.
import { createTestHarness } from 'wrangler';

const server = createTestHarness({ workers: [{ configPath: './wrangler.jsonc' }] });
try {
	await server.listen();
	const env = await server.getWorker().getEnv();
	await env.DB.exec('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
	const res = await server.fetch('/api/health');
	console.log(`[harness] ${JSON.stringify({ status: res.status, body: await res.json() })}`);
} finally {
	await server.close();
}
