// Vitest's stand-in for the Workers runtime module (vitest.config.ts aliases `cloudflare:workers` here): no bindings.
export const env: Readonly<Record<string, unknown>> = Object.freeze({});
