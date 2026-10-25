import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assembleNativeSchema, NATIVE_SCHEMA_INPUTS } from '../../../deploy/native-alpha/schema.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sources = () => NATIVE_SCHEMA_INPUTS.map(pin => ({ path: pin.path, bytes: readFileSync(`${root}/${pin.path}`) }));
const indices = NATIVE_SCHEMA_INPUTS.map((_, index) => index);

describe('native schema sparse-array regressions', () => {
	it('rejects a fully sparse array with the required length', () => {
		expect(() => assembleNativeSchema(new Array(NATIVE_SCHEMA_INPUTS.length))).toThrow(/missing schema input/);
	});

	it.each(indices)('rejects a deleted required index %i', index => {
		const inputs = sources();
		delete inputs[index];
		expect(() => assembleNativeSchema(inputs)).toThrow(`missing schema input at ${index}`);
	});

	it.each(indices)('rejects undefined and null entries at index %i', index => {
		for (const value of [undefined, null]) {
			const inputs = sources();
			(inputs as unknown[])[index] = value;
			expect(() => assembleNativeSchema(inputs)).toThrow(`input ${index}: unexpected or missing keys`);
		}
	});

	it.each(indices)('rejects an inherited required index %i', index => {
		const inputs = sources();
		const prototype = Object.create(Array.prototype);
		prototype[index] = inputs[index];
		delete inputs[index];
		Object.setPrototypeOf(inputs, prototype);
		expect(() => assembleNativeSchema(inputs)).toThrow(`missing schema input at ${index}`);
	});

	it('preserves the complete dense output without invoking a caller-overridden map', () => {
		const inputs = sources();
		const expected = assembleNativeSchema(inputs);
		Object.defineProperty(inputs, 'map', { value: () => { throw new Error('caller map invoked'); } });
		const actual = assembleNativeSchema(inputs);
		expect(actual).toEqual(expected);
		expect(actual.manifest.inputs.slice(1)).toEqual(NATIVE_SCHEMA_INPUTS);
		for (const input of inputs) expect(actual.sql).toContain(`-- ${input.path}\n${input.bytes.toString()}\n`);
	});

	it.each(indices)('still validates presence, path and exact bytes at index %i with an overridden map', index => {
		const inputs = sources();
		Object.defineProperty(inputs, 'map', { value: () => [] });
		const original = inputs[index]!;
		delete inputs[index];
		expect(() => assembleNativeSchema(inputs)).toThrow(/missing schema input/);
		inputs[index] = { ...original, path: '../outside.sql' };
		expect(() => assembleNativeSchema(inputs)).toThrow(/order\/path differs/);
		inputs[index] = { ...original, bytes: Buffer.from(original.bytes) };
		inputs[index]!.bytes[0] = inputs[index]!.bytes[0]! ^ 1;
		expect(() => assembleNativeSchema(inputs)).toThrow(/bytes differ from source pin/);
	});
});
