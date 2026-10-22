// A directory standing in for the Cloudflare account in the disposable-resource tests (GRS-107): <root>/<kind>/<name>
// is one resource, and a bucket's objects are files inside it.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Kind, Provider } from '../../../../deploy/probes/cloud-run.ts';

export function fakeCloud(root: string, fail: Kind[] = []): Provider & { names(): string[] } {
	return {
		create(kind, name) {
			const dir = path.join(root, kind, name);
			if (existsSync(dir)) throw new Error(`${kind} ${name} exists`);
			mkdirSync(dir, { recursive: true });
			if (kind === 'r2') writeFileSync(path.join(dir, 'object-1'), 'synthetic object');
		},
		remove(kind, name) {
			if (fail.includes(kind)) throw new Error(`synthetic ${kind} delete failure`);
			rmSync(path.join(root, kind, name), { recursive: true, force: true });
		},
		names: () => (existsSync(root) ? readdirSync(root).flatMap((kind) => readdirSync(path.join(root, kind)).map((n) => `${kind}/${n}`)).sort() : []),
	};
}
