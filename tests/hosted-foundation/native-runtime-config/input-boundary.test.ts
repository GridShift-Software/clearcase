// Caller data is read once, as own data. No getter, trap, iterator, toJSON, coercion or inherited value ever runs, and an error
// the module did not issue is never inspected.
import { describe, expect, it } from 'vitest';
import { nativeRuntimeConfigDiagnostic, planNativeRuntimeConfig } from '../../../deploy/native-alpha/runtime-config.ts';
import { exampleInput } from './example-input.ts';
import { refusalOf } from './harness.ts';

function trapped() {
	const calls: string[] = [];
	const handler = new Proxy({}, { get: (_t, trap) => (...args: unknown[]) => { calls.push(String(trap)); return Reflect.get(Reflect.getPrototypeOf(handler) ?? {}, trap) ?? (args as never); } });
	return { calls, handler: handler as ProxyHandler<object> };
}

describe('snapshot refusals', () => {
	it('refuses a getter at any depth without running it', () => {
		let ran = 0;
		const places: ((i: any) => void)[] = [
			(i) => Object.defineProperty(i, 'clients', { get() { ran++; return []; }, enumerable: true }),
			(i) => Object.defineProperty(i.manifest, 'staffIssuer', { get() { ran++; return 'https://staff.clerk.test'; }, enumerable: true }),
			(i) => Object.defineProperty(i.clients[0].policy.auditLimits, 'maxRows', { get() { ran++; return 1000; }, enumerable: true }),
			(i) => Object.defineProperty(i.clients[0].deployment, 'worker', { set() { ran++; }, enumerable: true }),
		];
		for (const place of places) { const i = exampleInput(); place(i); refusalOf(i); }
		expect(ran).toBe(0);
	});
	it('refuses a Proxy at any depth without invoking a single trap', () => {
		const { calls, handler } = trapped();
		const places: ((i: any) => void)[] = [
			(i) => { i.clients[0].policy = new Proxy(i.clients[0].policy, handler); },
			(i) => { i.clients[0].policy.storageBudgets = new Proxy(i.clients[0].policy.storageBudgets, handler); },
			(i) => { i.clients = new Proxy(i.clients, handler); },
			(i) => { i.manifest.clients = new Proxy(i.manifest.clients, handler); },
		];
		for (const place of places) { const i = exampleInput(); place(i); refusalOf(i); }
		expect(refusalOf(new Proxy(exampleInput(), handler))).toMatch(/\S/);
		expect(calls).toEqual([]);
	});
	it('refuses sparse, extended and subclassed arrays', () => {
		const sparse = exampleInput(); delete (sparse.clients as unknown[])[1]; // length stays 2, index 1 is a hole
		refusalOf(sparse);
		const extended: any = exampleInput(); extended.clients.extra = 1; refusalOf(extended);
		class Clients extends Array {}
		const subclass: any = exampleInput(); subclass.clients = Clients.from(subclass.clients); refusalOf(subclass);
		const holey: any = exampleInput(); holey.clients.length = 3; refusalOf(holey);
		const manifestHole: any = exampleInput(); delete manifestHole.manifest.clients[0]; refusalOf(manifestHole);
	});
	it('refuses inherited, non-enumerable, symbol-keyed, class-instance and null-extra objects', () => {
		const inherited: any = exampleInput();
		inherited.clients[0].deployment = Object.assign(Object.create({ clientId: 'client-a' }), { hostname: 'client-a.clearcase.test', worker: 'syn-client-a', d1DatabaseId: inherited.clients[0].deployment.d1DatabaseId,
			d1DatabaseName: 'syn-client-a-db', r2Bucket: 'syn-client-a-files' });
		refusalOf(inherited);
		const hidden: any = exampleInput(); Object.defineProperty(hidden.clients[0].deployment, 'worker', { value: 'syn-client-a', enumerable: false }); refusalOf(hidden);
		const symbol: any = exampleInput(); symbol.clients[0][Symbol('s')] = 1; refusalOf(symbol);
		class Tuple { clientId = 'client-a'; hostname = 'client-a.clearcase.test'; worker = 'syn-client-a'; d1DatabaseId = ''; d1DatabaseName = ''; r2Bucket = ''; }
		const instance: any = exampleInput(); instance.clients[0].deployment = Object.assign(new Tuple(), instance.clients[0].deployment); refusalOf(instance);
	});
	it('refuses values that are not plain JSON data, without calling their methods', () => {
		let ran = 0;
		const coercive = { toString() { ran++; return 'x'; }, valueOf() { ran++; return 1; }, toJSON() { ran++; return 'x'; } };
		for (const bad of [coercive, new String('syn-client-a'), new Number(1), Object(1n), () => 'x', Symbol('x'), 1n, undefined, new Date(0), new Map(), new Uint8Array(1), NaN, -Infinity, 'x'.repeat(9000)]) {
			const i: any = exampleInput(); i.clients[0].deployment.worker = bad; refusalOf(i);
			const j: any = exampleInput(); j.clients[0].policy.auditLimits.maxRows = bad; refusalOf(j);
		}
		const top: any = exampleInput(); top.toJSON = coercive.toJSON; refusalOf(top);
		expect(ran).toBe(0);
	});
	it('refuses a __proto__ field as an unknown field and keeps it inert', () => {
		const i: any = JSON.parse(`{"__proto__":{"polluted":true},${JSON.stringify(exampleInput()).slice(1)}`);
		expect(Object.keys(i)).toContain('__proto__');
		expect(refusalOf(i)).toMatch(/exactly/);
		expect(({} as any).polluted).toBeUndefined();
	});
	it('refuses excessive nesting and node counts', () => {
		let deep: unknown = 1; for (let n = 0; n < 20; n++) deep = { a: deep };
		const nested: any = exampleInput(); nested.extra = deep; refusalOf(nested);
		const wide: any = exampleInput(); wide.extra = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 'x')); refusalOf(wide);
	});
});

describe('error handling reads nothing it did not issue', () => {
	it('the diagnostic lookup answers only for issued errors and never touches a foreign or proxied error', () => {
		const { calls, handler } = trapped();
		let ran = 0;
		const foreign = Object.defineProperty(new Error('x'), 'message', { get() { ran++; return 'leak'; } });
		const proxied = new Proxy(new Error('x'), handler);
		expect(nativeRuntimeConfigDiagnostic(foreign)).toBeUndefined();
		expect(nativeRuntimeConfigDiagnostic(proxied)).toBeUndefined();
		expect(nativeRuntimeConfigDiagnostic('text')).toBeUndefined();
		expect(nativeRuntimeConfigDiagnostic(null)).toBeUndefined();
		try { planNativeRuntimeConfig({}); } catch (issued) {
			const message = nativeRuntimeConfigDiagnostic(issued);
			expect(message).toMatch(/exactly/);
			expect(nativeRuntimeConfigDiagnostic(new Proxy(issued as object, handler))).toBeUndefined(); // a Proxy of an issued error is a different key
			expect(nativeRuntimeConfigDiagnostic(Object.assign(issued as object, { message: 'changed' }))).toBe(message); // mutation cannot rewrite it
		}
		expect([ran, calls]).toEqual([0, []]);
	});
	it('a validator failure is reported by position only, with the validator\'s own message discarded', () => {
		const i = exampleInput();
		i.clients[0]!.policy.auditLimits.maxRows = 0;
		const message = refusalOf(i);
		expect(message).toBe('input.clients[0].policy.auditLimits: refused by the current runtime validator');
	});
});
