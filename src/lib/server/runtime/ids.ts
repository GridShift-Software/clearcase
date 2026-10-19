export type Id<K extends string> = string & { readonly __id: K };
export type ClientId = Id<'client'>;
export type CaseId = Id<'case'>;
export type ResultsVersion = Id<'results'>;
export type Sha256 = Id<'sha256'>;
export type SessionId = Id<'session'>;
export type WorkVersion = Id<'row-version'>;
export type CaseRevision = Id<'case-revision'>;

export function id<K extends string>(kind: K, value: string): Id<K> {
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
