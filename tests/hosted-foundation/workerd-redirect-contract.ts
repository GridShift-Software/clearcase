// Models the ONE workerd fact the Bun test runtime lacks. In workerd, constructing a Request, or calling fetch, with a redirect
// other than 'follow' or 'manual' throws a TypeError: 'error' is not implemented (Cloudflare Request docs, `redirect`). Bun accepts it.
// Every other behaviour is Bun's own builtin, reached through a Proxy, so `instanceof`, statics and responses are unchanged.
// This is a unit double for that single rule, never workerd evidence; the parent's real-workerd receipt owns the fact itself.
const WORKERD_REDIRECT_MODES = new Set<unknown>([undefined, 'follow', 'manual']);
const refusal = (mode: unknown) => new TypeError(`redirect mode ${JSON.stringify(mode)} is not implemented by workerd; use 'manual' and check the status`);

/** Installs the rule on the global Request and fetch. Returns the restore; the builtins are put back by identity. */
export function installWorkerdRedirectContract(): () => void {
 const builtinRequest = globalThis.Request, builtinFetch = globalThis.fetch;
 const requestInit = (args: unknown[]) => (args[1] ?? undefined) as RequestInit | undefined;
 const strictRequest: typeof Request = new Proxy(builtinRequest, {
  construct(target, args, newTarget) {
   const mode = requestInit(args)?.redirect;
   if (!WORKERD_REDIRECT_MODES.has(mode)) throw refusal(mode);
   return Reflect.construct(target, args, newTarget === strictRequest ? target : newTarget);
  },
 });
 const strictFetch: typeof fetch = new Proxy(builtinFetch, {
  apply(target, thisArg, args) {
   const mode = requestInit(args)?.redirect;
   return WORKERD_REDIRECT_MODES.has(mode) ? Reflect.apply(target, thisArg, args) : Promise.reject(refusal(mode));
  },
 });
 globalThis.Request = strictRequest; globalThis.fetch = strictFetch;
 return () => { globalThis.Request = builtinRequest; globalThis.fetch = builtinFetch; };
}
