// Real app/workerd/D1/R2; crafted RSA issuers and a loopback session-status double. Never Clerk evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { craftedIssuer, statusDouble } from '../identity/crafted.ts';
import { realNode, freePorts, build, checkInstalled } from '../identity/harness.ts';
import { ROOT, git } from './check.mjs';
import { CLIENTS, transcript } from './transcript.mjs';
import { world } from './world.mjs';
import { sweep } from './scenario.mjs';

test('same reciprocal sweep exercises separate native workerd client stores', { timeout: 600_000 }, async () => {
	const node = realNode();
	checkInstalled();
	const parent = path.join(ROOT, '.local/hosting-probe/identity-client-isolation');
	mkdirSync(parent, { recursive: true });
	const dir = mkdtempSync(path.join(parent, 'crafted-'));
	mkdirSync(path.join(dir, 'logs'));
	const sha = git(['rev-parse', 'HEAD']);
	build(node, dir, sha, process.env.PROBE_BUN);
	const ports = await freePorts(4);
	const origins = { a: `http://127.0.0.1:${ports[0]}`, c: `http://127.0.0.1:${ports[2]}` };
	const staffOrigins = { a: `http://127.0.0.1:${ports[1]}`, c: `http://127.0.0.1:${ports[3]}` };
	const issuers = { a: craftedIssuer('crafted-a.clerk.invalid'), c: craftedIssuer('crafted-c.clerk.invalid'), staff: craftedIssuer('crafted-staff.clerk.invalid') };
	const status = await statusDouble();
	const worlds = {};
	try {
		for (const [i, name] of CLIENTS.entries()) {
			const keys = new Map([['CLIENT_A_PK', issuers[name].publishableKey], ['CLIENT_A_SK', 'sk_test_synthetic-placeholder-not-a-key'], ['CLIENT_A_JWT_KEY', issuers[name].jwtKey],
				['STAFF_PK', issuers.staff.publishableKey], ['STAFF_SK', 'sk_test_synthetic-placeholder-not-a-key'], ['STAFF_JWT_KEY', issuers.staff.jwtKey]]);
			worlds[name] = await world({ node, dir: path.join(dir, name), ports: ports.slice(i * 2, i * 2 + 2), keys, clientSubject: `user_${name}`, staffSubject: `user_staff_${name}`, sha, apiUrl: status.url });
			worlds[name].token = async (actor, staff) => {
				const other = name === 'a' ? 'c' : 'a';
				const issuer = actor === 'operator' || (actor === 'wrong-party' && staff) ? 'staff' : actor === 'foreign' ? other : name;
				const azp = actor === 'operator' ? staffOrigins[name] : actor === 'wrong-party' ? (staff ? staffOrigins[other] : origins[other]) : origins[name];
				const sub = issuer === 'staff' ? `user_staff_${name}` : `user_${issuer}`;
				const sid = `sess_${sub}`;
				status.set(sid, sub);
				const now = Math.floor(Date.now() / 1000);
				return issuers[issuer].sign({ iss: issuers[issuer].iss, sub, sid, azp, iat: now - 1, nbf: now - 5, exp: now + 60, v: 2, fva: [0, -1] });
			};
		}
		const result = await sweep(worlds);
		assert.equal(result.results.length, transcript().length);
		assert.deepEqual(result.storesUnchanged, { a: true, c: true });
		assert.ok(result.results.every((r) => r.pass));
	} finally {
		try { for (const w of Object.values(worlds)) await w.stop(); }
		finally { await status.close(); }
	}
});
