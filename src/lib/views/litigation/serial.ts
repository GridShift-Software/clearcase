// Per-key serialization of register writes (one server process holds the store: an exclusive instance lock). A write
// that computes its `seq`, or finds the row it replaces, inside `fn` never races another write with the same key, even
// when both wait out a busy store. Browser-safe (no imports).
const queues = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier call with the same key has settled; a failure does not block later calls. */
export function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
	const settled = run.then(() => undefined, () => undefined);
	queues.set(key, settled);
	void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
	return run;
}
