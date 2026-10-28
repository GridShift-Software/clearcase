// The shard contract (ticket 04): the shape of every file the operator machine builds for a results version and the
// hosted loaders read. One module per shard family; this index only re-exports. A later ticket that needs a new type adds
// `payloads/<ticket>.ts` and imports it directly.
export type * from './payloads/shell.ts';
export type * from './payloads/overview.ts';
export type * from './payloads/views.ts';
export * from './payloads/list.ts';
export type * from './payloads/doc.ts';
export type * from './payloads/search.ts';
export type * from './payloads/bundles.ts';
export * from './payloads/manifest.ts';
