import { env, waitUntil } from 'cloudflare:workers';
import { createHandle, handleError } from './handle.ts';
import { hostedServices } from './services.ts';
import { clerkBrowserHandshakeFromEnv, handshakeResponse } from '../../../auth/clerk/browser.ts';
import { signInFormActionOrigins } from '../../../auth/clerk/config.ts';
import { installNativeCompositions } from './compositions.ts';
import { withPinnedOrigin } from './origin-guard.ts';
installNativeCompositions();

// Only the deployment's static handshake configuration is isolate-scoped, never a request's identity or audit sink.
let browser: ReturnType<typeof clerkBrowserHandshakeFromEnv> | undefined;
// Bindings come from the Worker's env and post-response work from the runtime's waitUntil, which extends the invocation
// that calls it: adapter-cloudflare 8 passes no platform, so there is no platform.env or platform.context.
// Clerk session tokens live a minute and no clerk-js runs here, so a request that is not a document renews an expired
// session on the Worker (browser.ts refresh); a document still renews it through the handshake.
// One Worker serves one origin: a request at any other origin is refused, for every method, before identity or routing.
export const handle = withPinnedOrigin(() => env.CLEARCASE_APP_ORIGIN, createHandle((request, credential) => hostedServices(request, env, { waitUntil: (work) => waitUntil(work) }, credential), async (request) => {
	browser ??= clerkBrowserHandshakeFromEnv(env);
	return browser.ok ? handshakeResponse(await browser.handshake.handle(request)) : null;
}, (path) => signInFormActionOrigins(env, path), async (request) => {
	browser ??= clerkBrowserHandshakeFromEnv(env);
	return browser.ok ? browser.handshake.refresh(request) : null;
}));
export { handleError };
