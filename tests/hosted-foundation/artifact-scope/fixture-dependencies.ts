// Fixed synthetic dependency bytes for the pre-existing scope-only fixtures. Those tests deliberately place raw
// SDK/Kit modules at synthetic emitted paths. Their formerly missing relative imports must now resolve too; these
// are not generated from scan results, and do not mock any scanner decision or claim framework runtime acceptance.
export const scopeFixtureDependencies: Record<string, string> = {
	'.svelte-kit/output/server/chunks/work.js': 'export const process = { html: "synthetic" };',
	'.svelte-kit/output/server/util/assert.js': 'export function assert(value) { if (!value) throw new Error("synthetic assertion"); }',
	'.svelte-kit/output/utils/error.js': 'export function set_error_stack(error, stack) { error.stack = stack; }',
	'.svelte-kit/output/server/chunks/dev.js': 'export function restore() {} export function save() {}',
	'.svelte-kit/output/server/utils.js': 'export function stream_from_iterable(value) { return value; }',
	'.svelte-kit/output/pathname.js': 'export const get_route_segments = x => x, is_remote_function = () => false, strip_prefix = x => x;',
	'.svelte-kit/output/runtime/server/remote-functions.js': 'export const has_remote_prefix = () => false, strip_remote_prefix = x => x;',
	'.svelte-kit/output/server/chunks/sourcemaps.js': 'export function fix_stack_trace() {} export function set_fix_stack_trace() {}',
	'.svelte-kit/output/server/nodes/0.js': 'export const index = 0;',
};
