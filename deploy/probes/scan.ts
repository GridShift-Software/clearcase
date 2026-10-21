// Credential scan of build artifacts, logs and a probe's outputs (GRS-107). Two kinds of rule: the exact canary values a
// run planted in the trusted parent's environment, which must never reach a child's output, and credential shapes
// (token variables, prefixed Cloudflare tokens, bearer headers, Clerk secret keys, private keys, Wrangler OAuth state).
// A hit names the file and the rule, never the matched text.
//
//   bun deploy/probes/scan.ts [--canaries FILE] PATH...
//
// FILE holds one canary per line, so no canary appears in a command line. Exit 0 clean, 1 on a hit, 2 when a path is missing.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULES: Record<string, RegExp> = {
	'token-variable': /\b(?:CLOUDFLARE_API_TOKEN|CLOUDFLARE_API_KEY|CF_API_TOKEN|CF_API_KEY|CLERK_SECRET_KEY)["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}/,
	// cfat_ (account-owned tokens) is in the token docs read for GRS-102; cfut_ and cfk_ are the same family's user token and key prefixes, unverified
	'cloudflare-prefixed-token': /\bcf(?:at|ut|k)_[A-Za-z0-9_-]{20,}/,
	'auth-header': /\b(?:authorization["']?\s*[:=]\s*["']?bearer\s+[A-Za-z0-9._-]{20,}|x-auth-key["']?\s*[:=]\s*["']?[0-9a-f]{37}\b)/i,
	'clerk-secret-key': /\bsk_(?:live|test)_[A-Za-z0-9]{20,}/,
	// the header followed by key material: a library that only names the header (a PEM parser, say) does not match
	'private-key': /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=\s]{64,}/,
	'oauth-state': /\b(?:oauth_token|refresh_token)["']?\s*[:=]\s*["'][^"'\s]{10,}/,
};
const MAX_BYTES = 64 << 20;

export type Hit = { file: string; rule: string };

function files(root: string): string[] {
	const st = statSync(root);
	if (st.isFile()) return [root];
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => path.join(e.parentPath, e.name))
		.sort();
}

/** Every file under `roots` that holds a canary or a credential shape. Binary files are read as latin1, so ASCII credentials in a SQLite page or a bundle still match. */
export function scanPaths(a: { roots: string[]; canaries: string[]; base?: string }): { hits: Hit[]; files: number } {
	const canaries = a.canaries.filter((c) => c.length >= 12);
	if (canaries.length !== a.canaries.length) throw new Error('a canary shorter than 12 characters would match by chance');
	const hits: Hit[] = [];
	let count = 0;
	for (const root of a.roots) {
		if (!existsSync(root)) throw new Error(`${root} does not exist`);
		for (const file of files(root)) {
			const size = statSync(file).size;
			const name = path.relative(a.base ?? process.cwd(), file);
			if (size > MAX_BYTES) {
				hits.push({ file: name, rule: 'too-large-to-scan' });
				continue;
			}
			const text = readFileSync(file, 'latin1');
			count++;
			canaries.forEach((c, i) => text.includes(c) && hits.push({ file: name, rule: `canary-${i + 1}` }));
			for (const [rule, re] of Object.entries(RULES)) if (re.test(text)) hits.push({ file: name, rule });
		}
	}
	return { hits, files: count };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const i = args.indexOf('--canaries');
	const canaries = i < 0 ? [] : readFileSync(args.splice(i, 2)[1]!, 'utf8').split('\n').filter(Boolean);
	try {
		if (!args.length) throw new Error('usage: scan.ts [--canaries FILE] PATH...');
		const { hits, files: n } = scanPaths({ roots: args, canaries });
		for (const h of hits) console.log(`${h.file}: ${h.rule}`);
		console.log(`SCAN ${hits.length ? 'FAIL' : 'PASS'}: ${n} files, ${canaries.length} canaries, ${hits.length} hits`);
		process.exitCode = hits.length ? 1 : 0;
	} catch (e) {
		console.error(`scan: ${(e as Error).message}`);
		process.exitCode = 2;
	}
}
