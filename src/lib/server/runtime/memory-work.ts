import type * as C from './contracts.ts';
import type { MemoryContext } from './memory.ts';
import { copy } from './data.ts';
import { id, sha256 } from './ids.ts';
import { contractError } from './errors.ts';
import { viewSeeds } from '../../case-package/user-work.ts';
import { Type, type TSchema } from 'typebox';
import { Compile } from 'typebox/compile';

// The double's built-in snapshot rows, parsed whole at the restore boundary: every field present, typed and no other.
const Text = Type.String({ minLength: 1 }), Iso = Type.String({ pattern: '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(?:\\.\\d+)?Z$' });
const Results = Type.String({ pattern: '^sha256:[0-9a-f]{64}$' }), Digest = Type.String({ pattern: '^[0-9a-f]{64}$' });
const strict = <T extends Record<string, TSchema>>(fields: T) => Type.Object(fields, { additionalProperties: false });
const AnchorRow = strict({ caseId: Text, resultsVersion: Results, refAtCreation: Text, sha256: Type.Union([Digest, Type.Null()]) });
const NoteRow = Compile(strict({
  id: Text, body: Type.String(), createdAt: Iso, intact: Type.Boolean(), candidates: Type.Array(Type.String()),
  status: Type.Union(['here', 'exact', 'ambiguous', 'missing', 'unanchored'].map((s) => Type.Literal(s))),
  target: Type.Union([strict({ kind: Type.Literal('case') }), strict({ kind: Type.Literal('document'), anchor: AnchorRow }), strict({ kind: Type.Literal('analysis'), resultsVersion: Results, section: Text })]),
}));
const TargetRow = Compile(Type.Union([strict({ kind: Type.Literal('case') }), strict({ kind: Type.Literal('document'), anchor: AnchorRow }), strict({ kind: Type.Literal('analysis'), resultsVersion: Results, section: Text })]));
const AnchorCheck = Compile(AnchorRow);
const OverlayRow = Compile(strict({ caseId: Text, datasetKey: Text, seedId: Text, baseSeedSha256: Type.String(), fields: Type.Record(Type.String(), Type.Unknown()) }));
const RegisterRowPayload = Compile(strict({ rowId: Text, store: Text, anchor: Type.Union([AnchorRow, Type.Null()]), fields: Type.Record(Type.String(), Type.Unknown()), createdAt: Iso, updatedAt: Iso, intact: Type.Boolean() }));
function parsed<T>(validator: { Check(value: unknown): boolean }, text: unknown): T {
  let value: unknown;
  try { value = JSON.parse(String(text)); } catch { invalid(); }
  if (!validator.Check(value)) invalid();
  return value as T;
}

type WorkRow = C.Versioned<C.WorkRegisterRow>;
type TableRow = { cells: Record<string, C.TableCell>; version: C.WorkVersion };
export interface WorkState {
  revision: C.CaseRevision;
  notes: Map<string, C.Versioned<C.HostedNote>>;
  rows: Map<string, WorkRow>;
  overlays: Map<string, C.Versioned<C.SeedOverlay>>;
  tables: Map<string, Map<string, TableRow>>;
  schemaChanges: Map<string, C.UserWorkTable>;
  operations: Map<string, { payload: string; result: C.Written<unknown> }>;
}
export function newWork(): WorkState { return { revision: id('case-revision', 'revision-0'), notes: new Map(), rows: new Map(), overlays: new Map(), tables: new Map(), schemaChanges: new Map(), operations: new Map() }; }
const key = (...values: string[]) => JSON.stringify(values);
const token = () => id('row-version', crypto.randomUUID());
const revision = () => id('case-revision', crypto.randomUUID());
const invalid = () => { throw contractError('invalid'); };
function storeName(value: string) { if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) invalid(); }
function fields(value: Record<string, unknown>): C.Fields {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  for (const [k, v] of Object.entries(value)) if (['__proto__', 'constructor', 'prototype'].includes(k) || !(v === null || typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number' && Number.isFinite(v))) invalid();
  if (new TextEncoder().encode(JSON.stringify(value)).length > 64 * 1024) invalid();
  return copy(value) as C.Fields;
}
function body(value: string) { const out = value.replace(/\r\n?/g, '\n').trim(); if (!out || out.length > 20_000) invalid(); return out; }
function compare(expected: C.Expected, current: { version: C.WorkVersion } | undefined): 'stale' | 'gone' | null {
  if (expected.kind === 'absent') return current ? 'stale' : null;
  return !current ? 'gone' : current.version !== expected.version ? 'stale' : null;
}
const builtins = ['note', 'seed_overlay', 'register_row'];
const reserved = new Set([...builtins, 'trusted_warning', 'active', 'activation_log', 'version', 'package_file', 'document', 'asset', 'seed', 'import_attempt', 'case_assignment', 'membership']);
function definition(d: C.TableDefinition): C.UserWorkTable {
  if (reserved.has(d.name)) throw contractError('table-built-in');
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(d.name) || d.name.startsWith('sqlite') || d.name.startsWith('userwork_catalog') || !d.owner || typeof d.description !== 'string' || d.scope !== 'case' || !d.columns.length || !d.primaryKey.length) invalid();
  const seen = new Set<string>();
  for (const c of d.columns) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(c.name) || seen.has(c.name) || !['TEXT', 'INTEGER', 'REAL', 'BLOB'].includes(c.type)) invalid();
    seen.add(c.name);
  }
  const caseColumn = d.columns.find((c) => c.name === 'case_id');
  if (!caseColumn || caseColumn.type !== 'TEXT' || !(caseColumn.notNull || d.primaryKey.includes('case_id')) || new Set(d.primaryKey).size !== d.primaryKey.length || d.primaryKey.some((n) => !seen.has(n))) invalid();
  return { name: d.name, owner: d.owner, description: d.description, kind: 'user-work', scope: 'case', columns: d.columns.map((c) => ({ name: c.name, type: c.type, notNull: !!c.notNull || d.primaryKey.includes(c.name), pk: d.primaryKey.indexOf(c.name) + 1 })) };
}
function builtin(name: string): C.UserWorkTable { return { name, owner: 'runtime', description: 'Memory diagnostic encoding', kind: 'user-work', scope: 'case', columns: [{ name: 'case_id', type: 'TEXT', notNull: true, pk: 1 }, { name: 'id', type: 'TEXT', notNull: true, pk: 2 }, { name: 'payload', type: 'TEXT', notNull: true, pk: 0 }] }; }
function tableKey(t: C.UserWorkTable, row: Record<string, C.TableCell>) {
  const keys = t.columns.filter((c) => c.pk).sort((a, b) => a.pk - b.pk);
  if (keys.some((c) => row[c.name] === null || row[c.name] === undefined)) throw contractError('restore-key');
  return JSON.stringify(keys.map((c) => row[c.name]));
}
function cells(t: C.UserWorkTable, row: Record<string, C.TableCell>, caseId: C.CaseId, partial = false) {
  if (!row || Array.isArray(row) || Object.keys(row).some((name) => !t.columns.some((c) => c.name === name))) invalid();
  if (row.case_id !== caseId) throw contractError('restore-key-collision');
  const out: Record<string, C.TableCell> = {};
  for (const c of t.columns) {
    if (partial && !c.pk && c.name !== 'case_id') continue;
    let v = row[c.name] ?? null;
    if (v === null && c.notNull) invalid();
    if (typeof v === 'number' && !Number.isFinite(v)) invalid();
    if (c.type === 'TEXT' && v !== null && typeof v !== 'string') invalid();
    if (typeof v === 'object' && v !== null) {
      if ('$int' in v) { if (!/^-?\d+$/.test(v.$int) || BigInt(v.$int) < -(2n ** 63n) || BigInt(v.$int) >= 2n ** 63n) invalid(); }
      else if ('$b64' in v) { if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.$b64)) invalid(); }
      else invalid();
    }
    if ((c.type === 'INTEGER' || c.type === 'REAL') && typeof v === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(v)) { const n = Number(v); if (!Number.isFinite(n)) invalid(); v = n; }
    if (c.type === 'INTEGER' && c.pk && !(typeof v === 'number' && Number.isSafeInteger(v) || typeof v === 'object' && v !== null && '$int' in v)) throw contractError('restore-key');
    out[c.name] = copy(v);
  }
  tableKey(t, out);
  return out;
}

export function createMemoryWork(ctx: MemoryContext, store: C.CaseReader): C.AsyncUserWork {
  const authorize = async (scope: C.Scope, operation: C.CaseOperation = 'read') => { await ctx.before(operation); await ctx.authorized(scope, operation, operation === 'read' ? 'user-work.read' : 'user-work.write'); };
  function owned(name: string, owner?: string) {
    if (reserved.has(name)) throw contractError('table-built-in');
    const t = ctx.state.definitions.get(name);
    if (!t) invalid();
    if (owner !== undefined && t!.owner !== owner) throw contractError('table-conflict');
    return t!;
  }
  async function change<T>(a: C.Scope & { operationId: string }, payload: unknown, fn: (next: WorkState, version: C.WorkVersion) => { kind: 'written'; value: T } | { kind: 'stale' | 'gone' }): Promise<C.Written<T>> {
    await authorize(a, 'write-user-work');
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(a.operationId)) invalid();
    const current = ctx.work(a.caseId), encoded = JSON.stringify(payload), previous = current.operations.get(a.operationId);
    if (previous) { if (previous.payload !== encoded) invalid(); return copy(previous.result) as C.Written<T>; }
    const next = copy(current), version = token(), result = fn(next, version);
    if (result.kind !== 'written') return result;
    next.revision = revision();
    const out: C.Written<T> = { ...result, version, caseRevision: next.revision };
    const actor: C.IdentityState = ctx.identity.kind === 'verified' ? { kind: 'verified', principal: ctx.identity.principal, sessionId: ctx.identity.sessionId } : { kind: 'anonymous', principal: null, sessionId: null };
    // No await or visible mutation separates the audit/outbox decision from the new work generation.
    ctx.audit({ eventId: `${a.caseId}:${a.operationId}`, actor, action: 'user-work.write', object: { kind: 'case', id: a.caseId, caseId: a.caseId }, version, outcome: 'succeeded', at: ctx.now().toISOString() });
    next.operations.set(a.operationId, { payload: encoded, result: copy(out) });
    for (const [name, table] of next.schemaChanges) ctx.state.definitions.set(name, table);
    next.schemaChanges.clear();
    ctx.state.work.set(a.caseId, next);
    return copy(out);
  }
  function setTable(next: WorkState, table: C.UserWorkTable, row: Record<string, C.TableCell>, caseId: C.CaseId, version: C.WorkVersion) {
    const normalized = cells(table, row, caseId), k = tableKey(table, normalized);
    for (const [other, w] of ctx.state.work) if (other !== caseId && w.tables.get(table.name)?.has(k)) throw contractError('restore-key-collision');
    let rows = next.tables.get(table.name); if (!rows) { rows = new Map(); next.tables.set(table.name, rows); }
    rows.set(k, { cells: normalized, version });
  }
  const work: C.AsyncUserWork = {
    async anchorFor(a) { const row = await store.documentRow(a); if (!row) throw contractError('not-found'); return { caseId: a.caseId, resultsVersion: a.resultsVersion, refAtCreation: a.ref, sha256: row.state.original ? sha256(row.state.original.sha256) : null }; },
    async resolve(a) {
      if (a.anchor.caseId !== a.into.caseId) throw contractError('forbidden');
      const fingerprints = await store.fingerprints(a.into);
      if (a.anchor.resultsVersion === a.into.resultsVersion) return { status: 'here', refs: [a.anchor.refAtCreation] };
      if (!a.anchor.sha256) return { status: 'unanchored', refs: [] };
      const refs = fingerprints.filter((f) => f.sha256 === a.anchor.sha256).map((f) => f.ref).sort();
      return { status: refs.length === 0 ? 'missing' : refs.length === 1 ? 'exact' : 'ambiguous', refs };
    },
    async notesFor(a) { await authorize(a); return copy([...ctx.work(a.caseId).notes.values()].filter((n) => a.target === null || JSON.stringify(n.target) === JSON.stringify(a.target))); },
    async summary(a) {
      const notes = await work.notesFor({ ...a, target: null });
      const result: C.HostedNoteSummary = { total: notes.length, here: 0, exact: 0, ambiguous: 0, missing: 0, unanchored: 0, byRef: [], detached: [] };
      for (const note of notes) {
        const match = note.target.kind === 'document' && a.resultsVersion ? await work.resolve({ anchor: note.target.anchor, into: { caseId: a.caseId, resultsVersion: a.resultsVersion } }) : { status: note.target.kind === 'case' ? 'here' as const : 'unanchored' as const, refs: [] };
        result[match.status]++;
        for (const ref of match.refs) { const old = result.byRef.find((r) => r.ref === ref); if (old) old.n++; else result.byRef.push({ ref, n: 1, status: match.status }); }
        if (!match.refs.length && note.target.kind !== 'case') result.detached.push({ ...note, status: match.status, candidates: match.refs });
      }
      return result;
    },
    async addNote(a) {
      if (!TargetRow.Check(a.target)) invalid();
      if (a.target.kind === 'document') { if (a.target.anchor.caseId !== a.caseId) throw contractError('forbidden'); await store.documentRows({ caseId: a.caseId, resultsVersion: a.target.anchor.resultsVersion }); }
      if (a.target.kind === 'analysis') await store.documentRows({ caseId: a.caseId, resultsVersion: a.target.resultsVersion });
      return change(a, ['note-add', a], (next, version) => { const note: C.HostedNote = { id: crypto.randomUUID(), body: body(a.body), createdAt: ctx.now().toISOString(), target: copy(a.target), status: 'here', candidates: [], intact: true }; next.notes.set(note.id, { ...note, version }); return { kind: 'written', value: note }; });
    },
    async deleteNote(a) { return change<boolean>(a, ['note-delete', a], (next) => { const conflict = compare(a.expected, next.notes.get(a.id)); if (conflict) return { kind: conflict }; next.notes.delete(a.id); return { kind: 'written', value: true }; }); },
    async seedRows(a) { return (await store.seeds(a)).filter((s) => a.datasetKey === undefined || s.datasetKey === a.datasetKey); },
    async overlays(a) { await authorize(a); return copy([...ctx.work(a.caseId).overlays.values()].filter((s) => a.datasetKey === undefined || s.datasetKey === a.datasetKey)); },
    async seedViews(a) {
      const seeds = await work.seedRows(a), overlays = await work.overlays(a);
      return viewSeeds(seeds, overlays).map((view) => {
        const seedId = 'seed' in view ? view.seed.seedId : view.overlay.seedId, datasetKey = 'seed' in view ? view.seed.datasetKey : view.overlay.datasetKey;
        return { ...view, version: overlays.find((o) => o.seedId === seedId && o.datasetKey === datasetKey)?.version ?? id('row-version', `seed:${'seed' in view ? view.seed.seedSha256 : 'absent'}`) };
      });
    },
    async putSeedOverlay(a) {
      if (!OverlayRow.Check(a.overlay)) invalid();
      if (a.overlay.caseId !== a.caseId) throw contractError('forbidden');
      return change(a, ['overlay', a], (next, version) => { const k = key(a.overlay.datasetKey, a.overlay.seedId), conflict = compare(a.expected, next.overlays.get(k)); if (conflict) return { kind: conflict }; next.overlays.set(k, { ...copy(a.overlay), fields: fields(a.overlay.fields), version }); return { kind: 'written', value: undefined }; });
    },
    async listRows(a) { await authorize(a); storeName(a.store); return copy([...ctx.work(a.caseId).rows.values()].filter((r) => r.store === a.store)); },
    async readNoteWork(a) {
      storeName(a.store);
      await authorize(a);
      const current = ctx.work(a.caseId), where = a.rowsWhere;
      return copy({ notes: [...current.notes.values()].filter((n) => a.target === null || JSON.stringify(n.target) === JSON.stringify(a.target)),
        rows: [...current.rows.values()].filter((r) => r.store === a.store && (!where || r.fields[where.field] === where.equals)) });
    },
    async readViewWork(a) {
      storeName(a.store);
      if (a.datasetKey !== undefined) storeName(a.datasetKey);
      await authorize(a);
      const current = ctx.work(a.caseId);
      return copy({ rows: [...current.rows.values()].filter((r) => r.store === a.store),
        overlays: a.datasetKey === undefined ? [] : [...current.overlays.values()].filter((o) => o.datasetKey === a.datasetKey) });
    },
    async putRow(a) { storeName(a.store); if (a.anchor !== null && !AnchorCheck.Check(a.anchor)) invalid(); if (a.anchor && a.anchor.caseId !== a.caseId) throw contractError('forbidden'); return change<C.AddResult>(a, ['row-put', a], (next, version) => {
      const rowId = a.rowId ?? crypto.randomUUID(), k = key(a.store, rowId), old = next.rows.get(k), conflict = compare(a.expected, old);
      if (conflict) return { kind: conflict }; const at = ctx.now().toISOString();
      next.rows.set(k, { rowId, store: a.store, fields: fields(a.fields), anchor: copy(a.anchor), createdAt: old?.createdAt ?? at, updatedAt: at, intact: true, version });
      return { kind: 'written', value: { rowId, repeated: false } };
    }); },
    async deleteRow(a) { storeName(a.store); return change<boolean>(a, ['row-delete', a], (next) => { const k = key(a.store, a.rowId), conflict = compare(a.expected, next.rows.get(k)); if (conflict) return { kind: conflict }; next.rows.delete(k); return { kind: 'written', value: true }; }); },
    async tables() { await ctx.identity.checkRevocation(); await ctx.before('read'); return copy([...builtins.map(builtin), ...ctx.state.definitions.values()]); },
    async defineTable(a) { await ctx.identity.checkRevocation(); await ctx.before('schema'); const t = definition(a.definition), old = ctx.state.definitions.get(t.name); if (old && JSON.stringify(old) !== JSON.stringify(t)) throw contractError('table-conflict'); ctx.state.definitions.set(t.name, t); },
    async registerStores(a) { await authorize(a); return [...new Set([...ctx.work(a.caseId).rows.values()].map((r) => r.store))].sort(); },
    async listTableRows(a) { await authorize(a); const t = owned(a.table); return copy([...(ctx.work(a.caseId).tables.get(t.name) ?? new Map<string, TableRow>())].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row]) => row)); },
    async putTableRow({ commitAfter, ...a }) { if (commitAfter) await commitAfter; return change(a, ['table-put', a], (next, version) => { const t = owned(a.table, a.owner), normalized = cells(t, a.row, a.caseId), k = tableKey(t, normalized), conflict = compare(a.expected, next.tables.get(t.name)?.get(k)); if (conflict) return { kind: conflict }; setTable(next, t, normalized, a.caseId, version); return { kind: 'written', value: undefined }; }); },
    async putTableRows(a) { return change(a, ['table-bulk', a], (next, version) => {
      if (next.revision !== a.expectedRevision) return { kind: 'stale' };
      const t = owned(a.table, a.owner), seen = new Set<string>();
      for (const row of a.rows) { const normalized = cells(t, row, a.caseId), k = tableKey(t, normalized); if (seen.has(k)) throw contractError('restore-key'); seen.add(k); setTable(next, t, normalized, a.caseId, version); }
      return { kind: 'written', value: undefined };
    }); },
    async deleteTableRow(a) { return change<boolean>(a, ['table-delete', a], (next) => { const t = owned(a.table, a.owner), k = tableKey(t, cells(t, a.key, a.caseId, true)), conflict = compare(a.expected, next.tables.get(t.name)?.get(k)); if (conflict) return { kind: conflict }; next.tables.get(t.name)?.delete(k); return { kind: 'written', value: true }; }); },
    async exportAll(a) {
      await authorize(a); const w = ctx.work(a.caseId);
      const encode = <T extends { version: C.WorkVersion }>(items: Map<string, T>) => [...items].map(([id, entry]) => { const { version: _, ...payload } = entry; return { case_id: a.caseId, id, payload: JSON.stringify(payload) }; });
      return { format: 'clearcase.user-work/1', exportedAt: ctx.now().toISOString(), tables: [
        { ...builtin('note'), rows: encode(w.notes) }, { ...builtin('seed_overlay'), rows: encode(w.overlays) }, { ...builtin('register_row'), rows: encode(w.rows) },
        ...[...ctx.state.definitions.values()].map((t) => ({ ...copy(t), rows: [...(w.tables.get(t.name)?.values() ?? [])].map((r) => copy(r.cells)) })),
      ] };
    },
    async importAll(a) {
      return change<C.ImportResult>(a, ['restore', a], (next, version) => {
        if (next.revision !== a.expectedRevision) return { kind: 'stale' };
        const receipt = ctx.state.snapshots.get(a.preRestore);
        if (!receipt || receipt.caseId !== a.caseId || receipt.revision !== a.expectedRevision) throw contractError('snapshot-failed');
        if (a.snapshot.format !== 'clearcase.user-work/1' || !Array.isArray(a.snapshot.tables)) invalid();
        const names = new Set<string>(), definitions = new Map(ctx.state.definitions);
        next.notes.clear(); next.rows.clear(); next.overlays.clear(); next.tables.clear();
        const restored: C.TableRestoreReport[] = [];
        for (const table of a.snapshot.tables) {
          if (names.has(table.name)) throw contractError('invalid'); names.add(table.name);
          if (table.scope !== 'case' || table.kind !== 'user-work' || reserved.has(table.name) && !builtins.includes(table.name)) throw contractError('restore-state');
          let known = builtins.includes(table.name) ? builtin(table.name) : definitions.get(table.name);
          if (!known) {
            const types = ['TEXT', 'INTEGER', 'REAL', 'BLOB'];
            if (!table.columns.every((c) => types.includes(c.type))) invalid();
            known = definition({ name: table.name, owner: table.owner, description: table.description, scope: table.scope, columns: table.columns.map((c) => ({ name: c.name, type: c.type as 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB', notNull: c.notNull })), primaryKey: table.columns.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name) });
            definitions.set(known.name, known); next.schemaChanges.set(known.name, known);
          }
          const { rows, ...metadata } = table;
          if (!known || JSON.stringify(known) !== JSON.stringify(metadata)) throw contractError('table-conflict');
          const seen = new Set<string>();
          for (const row of rows) {
            const normalized = cells(known, row, a.caseId), k = tableKey(known, normalized);
            if (seen.has(k)) throw contractError('restore-key'); seen.add(k);
            if (builtins.includes(table.name)) {
              if (typeof row.payload !== 'string' || typeof row.id !== 'string') throw contractError('invalid');
              const rowId = row.id;
              // The double's own versioned diagnostic DTOs, not a local/hosted migration format. Each row is parsed whole,
              // and its key must be the one its payload derives, so a row can never be stored under another row's name.
              const canonical = (expected: string) => { if (rowId !== expected) throw contractError('restore-key'); };
              if (table.name === 'note') {
                const note = parsed<C.HostedNote>(NoteRow, row.payload);
                if (body(note.body) !== note.body) invalid();
                canonical(note.id);
                if (note.target.kind === 'document' && note.target.anchor.caseId !== a.caseId) throw contractError('restore-key-collision');
                next.notes.set(note.id, { ...note, version });
              }
              if (table.name === 'seed_overlay') {
                const overlay = parsed<C.SeedOverlay>(OverlayRow, row.payload);
                if (overlay.caseId !== a.caseId) throw contractError('restore-key-collision');
                canonical(key(overlay.datasetKey, overlay.seedId));
                next.overlays.set(rowId, { ...overlay, fields: fields(overlay.fields), version });
              }
              if (table.name === 'register_row') {
                const r = parsed<C.WorkRegisterRow>(RegisterRowPayload, row.payload);
                storeName(r.store);
                canonical(key(r.store, r.rowId));
                if (r.anchor && r.anchor.caseId !== a.caseId) throw contractError('restore-key-collision');
                next.rows.set(rowId, { ...r, fields: fields(r.fields), version });
              }
            } else setTable(next, known, row, a.caseId, version);
          }
          restored.push({ name: table.name, scope: 'case', action: 'replaced-for-cases', rows: rows.length, deleted: 0, cases: [a.caseId] });
        }
        return { kind: 'written', value: { tables: names.size, rows: restored.reduce((n, t) => n + t.rows, 0), cases: [a.caseId], restored } };
      });
    },
    snapshots: {
      async put(a) {
        await authorize(a, 'write-user-work'); await ctx.before('snapshot');
        const { exportedAt: _currentTime, ...current } = await work.exportAll(a);
        const { exportedAt: _snapshotTime, ...snapshot } = a.snapshot;
        if (ctx.work(a.caseId).revision !== a.revision || JSON.stringify(current) !== JSON.stringify(snapshot)) throw contractError('snapshot-failed');
        // Recheck after the awaited read: no writer may pass between revision validation and receipt creation.
        if (ctx.work(a.caseId).revision !== a.revision) throw contractError('snapshot-failed');
        const receipt = id('snapshot', crypto.randomUUID()); ctx.state.snapshots.set(receipt, { caseId: a.caseId, revision: a.revision, snapshot: copy(a.snapshot) }); return receipt;
      },
      async get(a) { await authorize(a); await ctx.before('snapshot'); const snapshot = ctx.state.snapshots.get(a.id); if (snapshot && snapshot.caseId !== a.caseId) throw contractError('forbidden'); return snapshot ? copy(snapshot.snapshot) : null; },
    },
    registers: {
      open(scope) {
        storeName(scope.store);
        return {
          rows: () => work.listRows(scope),
          add: (a) => work.putRow({ ...scope, ...a, rowId: null, expected: { kind: 'absent' }, anchor: null }),
          async replace(a) { const r = await work.putRow({ ...scope, ...a, expected: { kind: 'match', version: a.expected }, anchor: (await work.listRows(scope)).find((r) => r.rowId === a.rowId)?.anchor ?? null }); return r.kind === 'written' ? { ...r, value: undefined } : r; },
          remove: (a) => work.deleteRow({ ...scope, ...a, expected: { kind: 'match', version: a.expected } }),
          async apply(a) { return change(scopeWithOperation(scope, a.operationId), ['register-apply', scope, a], (next, version) => {
            if (next.revision !== a.expectedRevision) return { kind: 'stale' };
            if (a.commands.length > 1000) invalid();
            for (const command of a.commands) {
              if (command.kind === 'remove') { if (!next.rows.delete(key(scope.store, command.rowId))) return { kind: 'gone' }; }
              else {
                const rowId = command.kind === 'add' ? crypto.randomUUID() : command.rowId, k = key(scope.store, rowId), old = next.rows.get(k);
                if (command.kind === 'replace' && !old) return { kind: 'gone' };
                const at = ctx.now().toISOString(); next.rows.set(k, { rowId, store: scope.store, fields: fields(command.fields), anchor: old?.anchor ?? null, intact: true, createdAt: old?.createdAt ?? at, updatedAt: at, version });
              }
            }
            return { kind: 'written', value: undefined };
          }); },
        };
      },
      seeds(scope) { return { views: () => work.seedViews(scope), async remove(a) {
        const seeds = await work.seedRows(scope), seed = seeds.find((s) => s.seedId === a.seedId);
        const result = await change<boolean>({ caseId: scope.caseId, operationId: a.operationId }, ['seed-remove', scope, a], (next, version) => {
          const publication = ctx.client.cases.find((c) => c.caseId === scope.caseId)?.publication;
          if (publication?.kind !== 'published' || publication.resultsVersion !== scope.resultsVersion) throw contractError('forbidden');
          const k = key(scope.datasetKey, a.seedId), overlay = next.overlays.get(k);
          if (!seed && !overlay) return { kind: 'gone' };
          const currentVersion = overlay?.version ?? id('row-version', `seed:${seed!.seedSha256}`);
          if (currentVersion !== a.expected) return { kind: 'stale' };
          next.overlays.set(k, { caseId: scope.caseId, datasetKey: scope.datasetKey, seedId: a.seedId, baseSeedSha256: seed?.seedSha256 ?? overlay!.baseSeedSha256, fields: { ...(overlay?.fields ?? {}), deleted: true }, version });
          return { kind: 'written', value: true };
        });
        return result.kind === 'gone' ? 'absent' : result;
      } }; },
    },
  };
  return work;
}
function scopeWithOperation(scope: C.Scope, operationId: string) { return { caseId: scope.caseId, operationId }; }
