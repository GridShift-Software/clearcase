// The existing app/harness is read-only. Each world gets its own local stores and process group.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appEnv, seed, startServe, stopServe, persistOf, run, wranglerArgs, fetchApp } from '../identity/harness.ts';
import { TABLES } from './transcript.mjs';

const id = (v) => { if (!/^user_[A-Za-z0-9_-]+$/.test(v)) throw new Error('unexpected synthetic subject ID'); return v; };
export async function world({ node, dir, ports, keys, clientSubject, staffSubject, sha, apiUrl }) {
	const logs = path.join(dir, 'logs');
	mkdirSync(logs, { recursive: true });
	const env = appEnv(node, dir);
	const persist = path.join(dir, 'persist');
	const client = { port: ports[0], origin: `http://127.0.0.1:${ports[0]}` };
	const staff = { port: ports[1], origin: `http://127.0.0.1:${ports[1]}` };
	const provision = path.join(dir, 'grants.sql');
	writeFileSync(provision, `INSERT INTO members VALUES ('client','${id(clientSubject)}','member',1,'2026-10-23T00:00:00Z');
INSERT INTO assignments VALUES ('client','${id(clientSubject)}','case-1','editor');
INSERT INTO operator_grants VALUES ('grs201','staff','${id(staffSubject)}','case-1','synthetic-provisioner','2099-01-01T00:00:00Z','2026-10-23T00:00:00Z',NULL);
`);
	seed(node, env, persist, logs, { client: ['schema/common.sql', 'schema/client.sql', 'schema/fixtures.sql', provision], staff: ['schema/common.sql'] });
	const config = { persist, logs, mfaRequired: false, jwtKeys: Boolean(apiUrl), client, staff, ...(apiUrl ? { apiUrl } : {}) };
	const server = await startServe(node, env, config, keys, logs);
	try {
		const stamp = await fetchApp(client.origin, '/_app/version.json');
		if (stamp.status !== 200 || JSON.parse(stamp.body).version !== sha) throw new Error('served build stamp mismatch');
	} catch (e) { await stopServe(server); throw e; }
	return {
		origin: client.origin, env, config,
		stop: () => stopServe(server),
		snapshot: async () => {
			const snapshots = [];
			for (const table of TABLES) {
				const r = run(node.path, wranglerArgs(['d1', 'execute', 'DB', '--local', '--env', 'client', '--persist-to', persistOf(persist, 'client'), '--json', '--command', `SELECT * FROM ${table} ORDER BY rowid`]), { env });
				if (r.code !== 0) throw new Error(`store snapshot failed: ${table}`);
				const parsed = JSON.parse(r.out);
				if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0].success || !Array.isArray(parsed[0].results)) throw new Error('unexpected D1 snapshot response');
				snapshots.push([table, parsed[0].results]);
			}
			return JSON.stringify(snapshots);
		},
	};
}
