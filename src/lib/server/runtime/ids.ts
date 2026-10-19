export type Id<K extends string> = string & { readonly __id: K };
export type ClientId = Id<'client'>;
export type CaseId = Id<'case'>;
export type ResultsVersion = Id<'results'>;
export type Sha256 = Id<'sha256'>;
export type SessionId = Id<'session'>;
export type WorkVersion = Id<'row-version'>;
export type CaseRevision = Id<'case-revision'>;

// The opaque kinds id() may brand. A results version and a digest have their own validators below; id() refuses them, so
// no string reaches those brands without its exact digest form.
const OPAQUE = ['client', 'case', 'session', 'row-version', 'case-revision', 'input-revision', 'snapshot'] as const;
export type OpaqueKind = (typeof OPAQUE)[number];
export function id<K extends OpaqueKind>(kind: K, value: string): Id<K> {
  if (!(OPAQUE as readonly string[]).includes(kind)) throw new TypeError(`id() cannot brand ${kind}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new TypeError(`Invalid ${kind} id`);
  return value as Id<K>;
}
export function sha256(value: string): Sha256 {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError('Invalid sha256');
  return value as Sha256;
}
export function resultsVersion(value: string): ResultsVersion {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new TypeError('Invalid resultsVersion');
  return value as ResultsVersion;
}
