import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkHostedGraph } from '../../../scripts/ci/hosted-imports.ts';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function project(hooks: string, files: Record<string, string> = {}, opts: { packages?: boolean } = {}) {
  const root = await mkdtemp(path.resolve('..', 'hosted-graph-')); roots.push(root);
  if (opts.packages) await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
  const entries = {
    'deploy/client/hosted-files.json': JSON.stringify({ routes: 'src/hosted/routes', hooks: { server: 'src/hosted/hooks.server' }, profiles: { 'hosted-gate': { hooks: { server: 'src/hosted/gate.server' } } } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', module: 'preserve', paths: { '$lib/*': ['./src/lib/*'], '$bridge': ['./src/bridge.ts'] } } }),
    'src/hosted/hooks.server.ts': hooks,
    'src/hosted/routes/[...path]/+server.ts': 'export const GET = () => new Response(null, {status:503});',
    ...files,
  };
  for (const [name, text] of Object.entries(entries)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
  return root;
}
describe('resolved hosted import boundary', () => {
  describe.each(['production', 'hosted-gate'] as const)('audit construction boundary in %s', (profile) => {
    const auditModules = {
      'src/lib/audit/index.ts': "export { requestAuditSink } from './facades';",
      'src/lib/audit/facades.ts': "export const requestAuditSink = () => ({ append: async () => ({ ok: true }) });",
      'src/lib/audit/trusted.ts': "export { createD1AuditLog } from './d1-log';",
      'src/lib/audit/d1-log.ts': "export const createD1AuditLog = () => ({ find: async () => ({ secret: 'synthetic-session' }) });",
    };
    async function auditProject(hooks: string, files: Record<string, string> = {}) {
      return project(hooks, { ...auditModules, 'src/hosted/gate.server.ts': hooks, ...files });
    }
    it.each(['$lib/audit', '$lib/audit/facades', '$lib/audit/trusted', '$lib/audit/d1-log'])('rejects direct audit construction from a route: %s', async (specifier) => {
      const root = await auditProject('export {};', {
        'src/hosted/routes/audit/+server.ts': `export * from '${specifier}';`,
      });
      expect(checkHostedGraph({ root, profile }).errors.join('\n')).toContain('audit construction is restricted to trusted hosted service composition');
    });
    it('rejects audit construction behind a re-export and literal dynamic import', async () => {
      const root = await auditProject("import '$bridge';", {
        'src/bridge.ts': "export * from './next';",
        'src/next.ts': "export const forge = () => import('$lib/audit/trusted');",
      });
      expect(checkHostedGraph({ root, profile }).errors.join('\n')).toContain('audit construction is restricted to trusted hosted service composition');
    });
    it('checks an untrusted audit edge even after trusted composition visited that module', async () => {
      const root = await auditProject("import '$lib/server/runtime/hosted/services';", {
        'src/lib/server/runtime/hosted/services.ts': "export { requestAuditSink } from '$lib/audit';",
        'src/hosted/routes/audit/+server.ts': "export { requestAuditSink } from '$lib/audit';",
      });
      expect(checkHostedGraph({ root, profile }).errors.join('\n')).toContain('routes/audit/+server.ts -> src/lib/audit/index.ts: audit construction is restricted to trusted hosted service composition');
    });
    it('allows trusted service composition and internal audit edges', async () => {
      const root = await auditProject("import '$lib/server/runtime/hosted/services';", {
        'src/lib/server/runtime/hosted/services.ts': "export { requestAuditSink } from '$lib/audit'; export { createD1AuditLog } from '$lib/audit/trusted';",
      });
      expect(checkHostedGraph({ root, profile }).errors).toEqual([]);
    });
    it('erases audit DTO type imports without giving routes construction power', async () => {
      const root = await auditProject('export {};', {
        'src/hosted/routes/audit/+server.ts': "import type { PublicAuditEvent } from '$lib/audit'; export const GET = () => new Response();",
      });
      expect(checkHostedGraph({ root, profile }).errors).toEqual([]);
    });
  });
  describe.each(['production', 'hosted-gate'] as const)('provisioning-only boundary in %s', (profile) => {
    const modules = {
      'src/lib/tenancy/index.ts': "export * from './management'; export { d1GrantRepository } from './d1-grants';",
      'src/lib/tenancy/management.ts': 'export const createGrantManagement = () => ({});',
      'src/lib/tenancy/d1-grants.ts': 'export const d1GrantRepository = () => ({});',
      'src/lib/tenancy/provisioning.ts': "export const createManagerBootstrap = () => ({ grantManager: async () => ({}) });",
      'src/lib/audit/provisioning.ts': "export const provisioningAuditPort = () => ({ append: async () => ({}) });",
      'src/lib/tenancy/case-provisioning.ts': 'export const provision = () => ({});',
      'src/lib/tenancy/case-grant-provisioning.ts': 'export const provision = () => ({});',
      'src/lib/tenancy/upload-provisioning.ts': 'export const provision = () => ({});',
      'src/lib/user-work/hosted/provision.ts': 'export const provision = () => ({});',
      'src/lib/audit/index.ts': "export { requestAuditSink } from './facades';",
      'src/lib/audit/facades.ts': 'export const requestAuditSink = () => ({ append: async () => ({}) });',
    };
    const make = (hooks: string, files: Record<string, string> = {}) => project(hooks, { ...modules, 'src/hosted/gate.server.ts': hooks, ...files });
    it.each(['$lib/tenancy/provisioning', '$lib/audit/provisioning', '$lib/tenancy/case-provisioning', '$lib/tenancy/case-grant-provisioning', '$lib/tenancy/upload-provisioning', '$lib/user-work/hosted/provision'])('rejects a deep import from a route: %s', async (specifier) => {
      const root = await make('export {};', { 'src/hosted/routes/boot/+server.ts': `import '${specifier}';` });
      expect(checkHostedGraph({ root, profile }).errors.join('\n')).toContain('provisioning-only module is unreachable from the hosted request graph');
    });
    it.each(['$lib/tenancy/case-provisioning', '$lib/tenancy/case-grant-provisioning', '$lib/tenancy/upload-provisioning', '$lib/user-work/hosted/provision'])('rejects the new provisioner behind trusted composition and a barrel: %s', async (specifier) => {
      const root = await make("import '$lib/server/runtime/hosted/services';", {
        'src/lib/server/runtime/hosted/services.ts': "export * from '$bridge';",
        'src/bridge.ts': `export const invoke = () => import('${specifier}');`,
      });
      expect(checkHostedGraph({ root, profile }).errors.join('\n')).toContain('provisioning-only module is unreachable from the hosted request graph');
    });
    it('rejects the bootstrap behind a re-export and a literal dynamic import', async () => {
      const root = await make("import '$bridge';", {
        'src/bridge.ts': "export * from './next';",
        'src/next.ts': "export const forge = () => import('$lib/tenancy/provisioning');",
      });
      expect(checkHostedGraph({ root, profile }).errors.join('\n')).toContain('provisioning-only module is unreachable from the hosted request graph');
    });
    it('rejects it even from the trusted service composer, and when another edge already visited it', async () => {
      const root = await make("import '$lib/server/runtime/hosted/services';", {
        'src/lib/server/runtime/hosted/services.ts': "export { createManagerBootstrap } from '$lib/tenancy/provisioning'; export { provisioningAuditPort } from '$lib/audit/provisioning';",
        'src/hosted/routes/boot/+server.ts': "export { createManagerBootstrap } from '$lib/tenancy/provisioning';",
      });
      const errors = checkHostedGraph({ root, profile }).errors.join('\n');
      expect(errors).toContain('services.ts -> src/lib/tenancy/provisioning.ts: provisioning-only module is unreachable from the hosted request graph');
      expect(errors).toContain('services.ts -> src/lib/audit/provisioning.ts: provisioning-only module is unreachable from the hosted request graph');
      expect(errors).toContain('routes/boot/+server.ts -> src/lib/tenancy/provisioning.ts: provisioning-only module is unreachable from the hosted request graph');
    });
    it('keeps the audit core, which holds the system-actor core, out of reach of the trusted composer by name', async () => {
      const root = await make("import '$lib/server/runtime/hosted/services';", {
        'src/lib/audit/d1-log.ts': 'export const provisioningCore = () => ({});',
        'src/lib/server/runtime/hosted/services.ts': "export { provisioningCore } from '$lib/audit/d1-log';",
      });
      expect(checkHostedGraph({ root, profile }).errors.join('\n')).toContain('services.ts -> src/lib/audit/d1-log.ts: audit core (with the system-actor provisioning core) is internal to src/lib/audit');
    });
    it('does not let the public tenancy and audit barrels reach it', async () => {
      const root = await make("import '$lib/tenancy'; import '$lib/audit';");
      expect(checkHostedGraph({ root, profile }).errors.join('\n')).not.toContain('provisioning-only');
    });
    it('erases a type-only import of the provisioning module', async () => {
      const root = await make('export {};', { 'src/hosted/routes/boot/+server.ts': "import type { createManagerBootstrap } from '$lib/tenancy/provisioning'; export const GET = () => new Response();" });
      expect(checkHostedGraph({ root, profile }).errors.join('\n')).not.toContain('provisioning-only');
    });
  });
  it('accepts the actual selected hosted graph and excludes host-only tooling', () => {
    const result = checkHostedGraph({ root: process.cwd() });
    expect(result.errors).toEqual([]);
    expect(result.files).toContain('src/lib/server/runtime/hosted/hooks.server.ts');
    expect(result.files.some((f) => f.includes('tests/') || f.includes('memory'))).toBe(false);
  });
  it('erases type-only imports but follows aliases, re-exports and literal dynamic imports', async () => {
    const root = await project("import type { Version } from '$lib/local-case/store.server'; import '$bridge';", {
      'src/bridge.ts': "export * from './next';",
      'src/next.ts': "export const read = () => import('$lib/local-case/db.server');",
      'src/lib/local-case/db.server.ts': "import 'node:sqlite';",
      'src/lib/local-case/store.server.ts': "import 'node:fs'; export type Version = string;",
    });
    const result = checkHostedGraph({ root });
    expect(result.errors.join('\n')).toContain('hooks.server.ts -> src/bridge.ts -> src/next.ts -> src/lib/local-case/db.server.ts');
    expect(result.files).not.toContain('src/lib/local-case/store.server.ts');
  });
  it.each(['node:fs', 'fs/promises', 'node:sqlite', 'node:net', 'http', 'node:https', 'child_process', 'node:cluster', 'bun:sqlite'])('rejects reachable %s', async (specifier) => {
    const root = await project("export * from '$bridge';", { 'src/bridge.ts': `import '${specifier}';` });
    expect(checkHostedGraph({ root }).errors.join('\n')).toContain(specifier);
  });
  it.each(['process.env.KEY', 'process.cwd()', 'process.pid', 'Bun.file("x")', 'Bun.serve({})', 'globalThis["process"].exit(1)', 'import(name)', 'require(name)', 'eval("x")'])('fails closed for %s', async (source) => {
    const root = await project(source);
    expect(checkHostedGraph({ root }).errors.length).toBeGreaterThan(0);
  });
  it('expands glob edges before tree shaking and checks every selected route', async () => {
    const root = await project("import.meta.glob('./widgets/*.ts', {eager:true});", {
      'src/hosted/widgets/a.ts': 'export const x = 1;',
      'src/hosted/widgets/b.ts': "import 'node:fs';",
      'src/hosted/routes/hidden/+page.server.ts': "export const load = () => import('node:net');",
    });
    const result = checkHostedGraph({ root });
    expect(result.errors.join('\n')).toContain('src/hosted/widgets/b.ts');
    expect(result.errors.join('\n')).toContain('src/hosted/routes/hidden/+page.server.ts');
  });
  // Draft review finding 1: the homemade glob missed Vite's zero-directory `**/` and brace alternatives.
  it.each([
    ["import.meta.glob('./widgets/**/*.ts', {eager:true});", 'src/hosted/widgets/unsafe.ts'],
    ["import.meta.glob('./widgets/*.{ts,js}', {eager:true});", 'src/hosted/widgets/unsafe.ts'],
    ["import.meta.glob(['./widgets/**/*.ts', '!./widgets/safe.ts']);", 'src/hosted/widgets/unsafe.ts'],
  ])('fails closed on every Vite glob form: %s', async (hooks, unsafe) => {
    const root = await project(hooks, { 'src/hosted/widgets/safe.ts': 'export const x = 1;', 'src/hosted/widgets/unsafe.ts': "import 'node:fs';" });
    expect(checkHostedGraph({ root }).errors.join('\n')).toMatch(new RegExp(`${unsafe.replaceAll('/', '\\/').replaceAll('.', '\\.')}|unsupported glob`));
  });
  it('fails closed on glob options that move its base', async () => {
    const root = await project("import.meta.glob('./*.ts', { base: '../lib' });", { 'src/lib/unsafe.ts': "import 'node:fs';" });
    expect(checkHostedGraph({ root }).errors.join('\n')).toMatch(/unsafe\.ts|unsupported glob/);
  });
  it('stops at the allowlisted framework packages and refuses any other package', async () => {
    const root = await project("import { error } from '@sveltejs/kit'; import { Type } from 'typebox'; export { error, Type }; import '$bridge';", { 'src/bridge.ts': "export { unzipSync } from 'fflate';" }, { packages: true });
    const errors = checkHostedGraph({ root }).errors.join('\n');
    expect(errors).toContain('src/bridge.ts: package outside the hosted allowlist fflate');
    expect(errors).not.toMatch(/@sveltejs\/kit|typebox/);
  });
  it('allows the Clerk SDK only inside its first-party identity implementation', async () => {
    const root = await project("import '$lib/auth/clerk/provider';", {
      'src/lib/auth/clerk/provider.ts': "export { createClerkClient } from '@clerk/backend';",
    }, { packages: true });
    expect(checkHostedGraph({ root }).errors).toEqual([]);
  });
  it('refuses a route constructing the Clerk SDK, even after a trusted identity import', async () => {
    const root = await project("import '$lib/auth/clerk/provider';", {
      'src/lib/auth/clerk/provider.ts': "export { createClerkClient } from '@clerk/backend';",
      'src/hosted/routes/sdk/+server.ts': "export { createClerkClient } from '@clerk/backend';",
    }, { packages: true });
    expect(checkHostedGraph({ root }).errors.join('\n')).toContain('Clerk SDK construction is restricted to the first-party identity implementation');
  });
  it('names only the Kit app modules and the Workers env module, nothing else of their schemes', async () => {
    const ok = await project("import { env } from 'cloudflare:workers'; import { page } from '$app/state'; import { browser } from '$app/env'; export { env, page, browser };", {}, { packages: true });
    expect(checkHostedGraph({ root: ok }).errors).toEqual([]);
    const bad = await project("import 'cloudflare:sockets'; import { read } from '$app/server'; export { read };", {}, { packages: true });
    const errors = checkHostedGraph({ root: bad }).errors.join('\n');
    expect(errors).toContain('forbidden capability cloudflare:sockets');
    expect(errors).toMatch(/hooks\.server\.ts: (?:unresolved|package outside the hosted allowlist) \$app\/server/);
  });
  it('refuses the memory doubles in every profile and the gate doubles outside the hosted-gate profile', async () => {
    const files = {
      'src/hosted/gate.server.ts': "export * from '$lib/server/runtime/hosted/gate/services';",
      'src/lib/server/runtime/hosted/gate/services.ts': 'export const gate = 1;',
      'src/lib/server/runtime/memory.ts': 'export const memory = 1;',
      'src/hosted/routes/probe/+server.ts': "export { memory } from '$lib/server/runtime/memory';",
    };
    const production = checkHostedGraph({ root: await project("export * from '$lib/server/runtime/hosted/gate/services';", files) }).errors.join('\n');
    expect(production).toContain('src/lib/server/runtime/hosted/gate/services.ts: forbidden test double in the production graph');
    expect(production).toContain('src/lib/server/runtime/memory.ts: forbidden test double in the production graph');
    const gate = checkHostedGraph({ root: await project('export {};', files), profile: 'hosted-gate' }).errors.join('\n');
    expect(gate).not.toContain('hosted/gate/services.ts');
    expect(gate).toContain('src/lib/server/runtime/memory.ts: forbidden test double in the hosted-gate graph');
  });
  it('refuses any module of the local route tree, the folder browser among it', async () => {
    const root = await project("export * from '$bridge';", { 'src/bridge.ts': "export { GET } from './routes/api/browse/+server.ts';", 'src/routes/api/browse/+server.ts': 'export const GET = () => new Response();' });
    expect(checkHostedGraph({ root }).errors.join('\n')).toContain('src/routes/api/browse/+server.ts: forbidden local route module');
  });
  it('compiles Svelte components it reaches by $lib or relative paths and walks their script blocks', async () => {
    const root = await project('export {};', {
      'src/hosted/routes/probe/+page.svelte': "<script lang=\"ts\">import Panel from '$lib/components/Panel.svelte';</script><Panel />",
      'src/lib/components/Panel.svelte': "<script lang=\"ts\">import Inner from './Inner.svelte';</script><Inner />",
      'src/lib/components/Inner.svelte': "<script lang=\"ts\">import { readFileSync } from 'node:fs'; const t = readFileSync('x', 'utf8');</script><p>{t}</p>",
    }, { packages: true });
    expect(checkHostedGraph({ root }).errors.join('\n')).toContain('src/lib/components/Panel.svelte -> src/lib/components/Inner.svelte: forbidden capability node:fs');
  });
  // Kit builds every file its own route patterns accept: layout-reset pages and layouts (+page@.svelte, +layout@name.svelte)
  // and the universal and server modules among them. Each is a root of the hosted graph.
  it.each([
    ['+page@.svelte', 'forbidden capability node:fs'],
    ['+page@root.svelte', 'forbidden capability node:fs'],
    ['+layout@.svelte', 'forbidden capability node:fs'],
    ['+layout@root.svelte', 'forbidden capability node:fs'],
    ['+page.ts', 'forbidden capability node:fs'],
    ['+page.server.js', 'forbidden capability node:fs'],
    ['+layout.ts', 'forbidden capability node:fs'],
    ['+layout.server.ts', 'forbidden capability node:fs'],
    ['+server.js', 'forbidden capability node:fs'],
  ])('walks the route file %s as a root', async (name, error) => {
    const text = name.endsWith('.svelte') ? "<script lang=\"ts\">import { readFileSync } from 'node:fs'; readFileSync('x');</script>" : "import 'node:fs';";
    const root = await project('export {};', { [`src/hosted/routes/probe/${name}`]: text }, { packages: true });
    expect(checkHostedGraph({ root }).errors.join('\n')).toContain(error);
  });
  it('catches process and a local import from a layout-reset route', async () => {
    const root = await project('export {};', {
      'src/hosted/routes/probe/+layout@.svelte': "<script lang=\"ts\">process.on('SIGTERM', () => {});</script>",
      'src/hosted/routes/other/+page@.svelte': "<script lang=\"ts\">import '$lib/local-case/db.server';</script>",
      'src/lib/local-case/db.server.ts': 'export {};',
    }, { packages: true });
    const errors = checkHostedGraph({ root }).errors.join('\n');
    expect(errors).toContain('+layout@.svelte: forbidden capability process');
    expect(errors).toContain('+page@.svelte -> src/lib/local-case/db.server.ts: forbidden local implementation');
  });
  it.each(['+foo.ts', '+page@x.ts', '+layout@x.server.ts', '+error.ts', '+page.mjs', '+page.svelte.bak', '+hook.svelte'])('fails closed on the reserved route file %s', async (name) => {
    const root = await project('export {};', { [`src/hosted/routes/probe/${name}`]: 'export {};' });
    expect(checkHostedGraph({ root }).errors.join('\n')).toContain(`${name}: reserved route file`);
  });
  it('leaves files without a + prefix alone', async () => {
    const root = await project('export {};', { 'src/hosted/routes/probe/helper.ts': "import 'node:fs';" });
    expect(checkHostedGraph({ root }).errors).toEqual([]);
  });
  it('accepts a stylesheet that exists by $lib or relative path, and fails one that is missing or outside the checkout', async () => {
    const page = (imports: string) => `<script lang="ts">${imports}</script><p>probe</p>`;
    const files = { 'src/lib/views/analysis/analysis.css': '.card {}', 'src/app.css': 'body {}', 'src/hosted/routes/probe/probe.css': 'p {}' };
    const ok = await project('export {};', { ...files, 'src/hosted/routes/probe/+page.svelte': page("import '$lib/views/analysis/analysis.css'; import '$lib/../app.css'; import './probe.css';") }, { packages: true });
    expect(checkHostedGraph({ root: ok }).errors).toEqual([]);
    const bad = await project('export {};', { ...files, 'src/hosted/routes/probe/+page.svelte': page("import '$lib/views/missing.css'; import '$lib/../../outside.css'; import 'some-package/styles.css';") }, { packages: true });
    const errors = checkHostedGraph({ root: bad }).errors.join('\n');
    for (const specifier of ['$lib/views/missing.css', '$lib/../../outside.css', 'some-package/styles.css']) expect(errors).toContain(`unresolved ${specifier}`);
  });
  it('walks a local version page re-exported through $local, and refuses every other local route module', async () => {
    const tsconfig = JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', module: 'preserve', paths: { '$lib/*': ['./src/lib/*'], '$local/*': ['./src/routes/v/[vid]/*'] } } });
    const wrapper = (target: string) => `<script lang="ts">import Page from '$local/${target}';</script><Page />`;
    const pages = {
      'tsconfig.json': tsconfig,
      'src/routes/v/[vid]/clean/+page.svelte': "<script lang=\"ts\">import Part from './Part.svelte';</script><Part />",
      'src/routes/v/[vid]/clean/Part.svelte': '<p>part</p>',
      'src/routes/v/[vid]/dirty/+page.svelte': "<script lang=\"ts\">import { readFileSync } from 'node:fs'; const t = readFileSync('x', 'utf8');</script><p>{t}</p>",
      'src/routes/v/[vid]/clean/+page.server.ts': 'export const load = () => ({});',
    };
    const clean = await project('export {};', { ...pages, 'src/hosted/routes/clean/+page.svelte': wrapper('clean/+page.svelte') }, { packages: true });
    const result = checkHostedGraph({ root: clean });
    expect(result.errors).toEqual([]);
    expect(result.files).toEqual(expect.arrayContaining(['src/routes/v/[vid]/clean/+page.svelte', 'src/routes/v/[vid]/clean/Part.svelte']));
    const dirty = await project('export {};', { ...pages, 'src/hosted/routes/dirty/+page.svelte': wrapper('dirty/+page.svelte') }, { packages: true });
    expect(checkHostedGraph({ root: dirty }).errors.join('\n')).toContain('src/routes/v/[vid]/dirty/+page.svelte: forbidden capability node:fs');
    const server = await project('export {};', { ...pages, 'src/hosted/routes/clean/+page.server.ts': "export { load } from '$local/clean/+page.server';" });
    expect(checkHostedGraph({ root: server }).errors.join('\n')).toContain('src/routes/v/[vid]/clean/+page.server.ts: forbidden local route module');
  });
  it('allows safe crypto and fails unresolved imports rather than skipping them', async () => {
    const root = await project("import 'node:crypto'; import './not-there';");
    const result = checkHostedGraph({ root });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('unresolved ./not-there');
  });
});
