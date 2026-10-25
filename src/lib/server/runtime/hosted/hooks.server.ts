import { env, waitUntil } from 'cloudflare:workers';
import { createHandle, handleError } from './handle.ts';
import { hostedServices } from './services.ts';
import { clerkBrowserHandshakeFromEnv, handshakeResponse } from '../../../auth/clerk/browser.ts';
import { signInFormActionOrigins } from '../../../auth/clerk/config.ts';
import { installNativeCompositions } from './compositions.ts';
installNativeCompositions();

// Only the deployment's static handshake configuration is isolate-scoped, never a request's identity or audit sink.
let browser: ReturnType<typeof clerkBrowserHandshakeFromEnv> | undefined;
// Bindings come from the Worker's env and post-response work from the runtime's waitUntil, which extends the invocation
// that calls it: adapter-cloudflare 8 passes no platform, so there is no platform.env or platform.context.
export const handle = createHandle((request) => hostedServices(request, env, { waitUntil: (work) => waitUntil(work) }), async (request) => {
	browser ??= clerkBrowserHandshakeFromEnv(env);
	return browser.ok ? handshakeResponse(await browser.handshake.handle(request)) : null;
}, (path) => signInFormActionOrigins(env, path));
export { handleError };
