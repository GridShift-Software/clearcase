import { Type, type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { contractError } from './errors.ts';
const Stamp = Type.Object({
  revision: Type.String({ pattern: '^[0-9a-f]{40}$' }), dirty: Type.Boolean(), exported: Type.Boolean(),
  builtAt: Type.String({ minLength: 1 }), bun: Type.Literal('1.4.2'), buildId: Type.String({ minLength: 1 }),
  target: Type.Literal('cloudflare'), profile: Type.Union([Type.Literal('production'), Type.Literal('hosted-gate')]),
}, { additionalProperties: false });
const validator = Compile(Stamp);
export function validateBuildStamp(value: unknown): Readonly<Static<typeof Stamp>> {
  if (!validator.Check(value) || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value.builtAt) || !Number.isFinite(Date.parse(value.builtAt))) throw contractError('invalid-build');
  return Object.freeze(structuredClone(value));
}
