#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: {
  root: { type: 'string', default: resolve(import.meta.dirname, '../../..') },
  oracle: { type: 'string' }, out: { type: 'string' }, reservations: { type: 'string' },
} });
const root = resolve(args.root);
const read = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));
const coverage = read('docs/plan/view-coverage.json');
const work = read('docs/plan/work-items.json');
const { VIEWS } = await import(join(root, 'src/lib/components/view-registry.ts'));
const categories = { 'CC-04': 'evidence', 'CC-05': 'analysis', 'CC-06': 'quantum', 'CC-07': 'registers', 'CC-08': 'litigation', 'CC-09': 'bundles', 'CC-10': 'system' };
assert.equal(VIEWS.length, 42);
assert.equal(new Set(VIEWS.map((view) => view.id)).size, 42);
assert.equal(coverage.documentCount, 1689);
assert.deepEqual(VIEWS.map(({ id, label, owner, group }) => ({ id, label, owner, group })), coverage.views.map(({ id, label, owner, group }) => ({ id, label, owner, group })));
const reservations = [];
for (const [owner, category] of Object.entries(categories)) {
  const item = work.items.find((item) => item.key === owner);
  assert(item, owner);
  const scopes = item.scope;
  assert(Array.isArray(scopes), `${owner} has an explicit scope`);
  const route = `src/routes/v/[vid]/${category}/**`;
  assert(scopes.includes(route), `${owner} owns ${route}`);
  assert(scopes.includes(`src/lib/views/${category}/**`));
  assert(item.depends.includes('CC-24'));
  assert(item.depends.includes('CC-29'));
  assert(item.depends.includes('CC-30'));
  const views = VIEWS.filter((view) => view.owner === owner);
  assert(views.length > 0);
  for (const view of views) {
    assert.equal(view.category, category);
    assert.equal(view.route, `/${category}/${view.id}`);
    assert.equal(view.status, `unavailable-until:${view.linear}`);
  }
  reservations.push({ owner, category, route, scopes, views: views.map((view) => view.id) });
}
assert.deepEqual(VIEWS.filter((view) => view.status === 'available').map((view) => view.id), ['overview', 'chronology']);
let oracle = null;
if (args.oracle) {
  const independent = JSON.parse(readFileSync(args.oracle, 'utf8'));
  assert.equal(independent.views.length, 42);
  assert.deepEqual(independent.views.map((view) => view.id).sort(), VIEWS.map((view) => view.id).sort());
  oracle = { views: 42, actions: independent.views.reduce((n, view) => n + view.actions.length, 0), labelDifferences: independent.views.flatMap((view) => {
    const registry = VIEWS.find((entry) => entry.id === view.id);
    return registry.label === view.label ? [] : [{ id: view.id, oracle: view.label, registry: registry.label }];
  }) };
  assert.deepEqual(oracle.labelDifferences, []);
}
const ownershipBlocks = [];
if (args.reservations) {
  const entries = readFileSync(args.reservations, 'utf8').trim().split('\n').slice(1).map((line) => {
    const [unit, linear, paths, reservedAt, releasedAt] = line.split('\t');
    return { unit, linear, paths: paths.split(';').map((path) => path.trim()), reservedAt, releasedAt };
  });
  const active = entries.filter((entry) => entry.releasedAt === '-');
  if (active.some((entry) => entry.unit === 'CC-03' && entry.paths.includes('src/routes/**'))) ownershipBlocks.push('CC-03 broad route reservation has not been released');
  for (const reservation of reservations) {
    if (!active.some((entry) => entry.unit === reservation.owner && entry.paths.includes(reservation.route))) ownershipBlocks.push(`${reservation.owner} route reservation is not recorded`);
  }
  for (const path of ['src/lib/local-case/**', 'src/routes/+layout.*', 'src/routes/v/[vid]/+layout.*', 'src/lib/components/**']) {
    if (!active.some((entry) => /coordinator|M2-shared/i.test(entry.unit) && entry.paths.includes(path))) ownershipBlocks.push(`coordinator reservation is not recorded: ${path}`);
  }
}
const result = { ok: ownershipBlocks.length === 0, views: 42, available: 2, unavailable: 40, oracle, reservations, ownershipBlocks };
if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2));
console.log(`PASS: 42 extension points, 40 explicit unavailable states, 7 owner scopes${oracle ? ', independent oracle matched' : ''}`);
for (const block of ownershipBlocks) console.error(`HOLD: ${block}`);
process.exit(result.ok ? 0 : 1);
