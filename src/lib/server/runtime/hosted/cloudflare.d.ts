// The Workers runtime module, typed only as far as the hosted entry reads it: `bindings()` checks each binding's shape.
declare module 'cloudflare:workers' {
	export const env: Readonly<Record<string, unknown>>;
}
