// Real source-edge checker; synthetic graph fixture, not request/deployment acceptance.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkHostedGraph } from '../../../scripts/ci/hosted-imports.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function graph(route: string, composer = "export { committedAuditRecovery } from '../../../audit/recovery';") {
  const root = mkdtempSync(join(process.cwd(), '.local', 'committed-audit-graph-')); roots.push(root);
  const entries = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', module: 'preserve' } }),
    'deploy/client/hosted-files.json': JSON.stringify({ routes: 'routes', hooks: { server: 'hooks.server' }, profiles: { 'hosted-gate': { hooks: { server: 'hooks.server' } } } }),
    'hooks.server.ts': "import './src/lib/server/runtime/hosted/services';",
    'src/lib/server/runtime/hosted/services.ts': composer,
    'src/lib/audit/recovery.ts': "import { committedDeliveryCore } from './d1-log'; export const committedAuditRecovery = () => committedDeliveryCore();",
    'src/lib/audit/d1-log.ts': 'export const committedDeliveryCore = () => ({});',
    'routes/recovery/+server.ts': route,
  };
  for (const [path, text] of Object.entries(entries)) {
    const full = join(root, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, text);
  }
  return root;
}

describe.each(['production', 'hosted-gate'] as const)('historical producer source barrier (%s)', (profile) => {
  it('allows the sole services composer and internal audit-to-core edge', () => {
    const result = checkHostedGraph({ root: graph('export const GET = () => new Response();'), profile });
    expect(result.errors).toEqual([]);
    expect(result.files).toContain('src/lib/audit/recovery.ts');
    expect(result.files).toContain('src/lib/audit/d1-log.ts');
  });
  it.each([
    "export { committedAuditRecovery } from '../../src/lib/audit/recovery';",
    "export const POST = () => import('../../src/lib/audit/recovery');",
    "export { committedDeliveryCore } from '../../src/lib/audit/d1-log';",
  ])('refuses a route reaching a historical constructor even after trusted traversal: %s', (route) => {
    const result = checkHostedGraph({ root: graph(route), profile });
    expect(result.errors.join('\n')).toContain('audit construction is restricted to trusted hosted service composition');
  });
  it('does not expose the generic internal core even to the services composer by name', () => {
    const result = checkHostedGraph({ root: graph('export {};', "export { committedDeliveryCore } from '../../../audit/d1-log';"), profile });
    expect(result.errors.join('\n')).toContain('audit core (with the system-actor provisioning core) is internal to src/lib/audit');
  });
});
