// Node preload for `secrets.ts --to env` (GRS-107). It takes the values off fd 3 and serves them from process.env to
// this process only: a read by name returns them, but they are not own keys, so Node's child_process (which builds a
// child's environment from Object.keys of process.env), a spread or Object.assign copy, and JSON.stringify leave them
// out. Assigning or deleting a secret's key drops the served value.
import { takeSecrets } from './secrets-child.mjs';

const secrets = takeSecrets();
const real = process.env;
process.env = new Proxy(real, {
	get: (target, key) => (typeof key === 'string' && secrets.has(key) ? secrets.get(key) : Reflect.get(target, key)),
	has: (target, key) => (typeof key === 'string' && secrets.has(key)) || Reflect.has(target, key),
	set: (target, key, value) => (typeof key === 'string' && secrets.delete(key), Reflect.set(target, key, value)),
	deleteProperty: (target, key) => (typeof key === 'string' && secrets.delete(key), Reflect.deleteProperty(target, key)),
});
