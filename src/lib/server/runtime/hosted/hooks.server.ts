import { env } from 'cloudflare:workers';
import { createHandle, handleError } from './handle.ts';
import { hostedServices } from './services.ts';
import { clerkBrowserHandshakeFromEnv, handshakeResponse } from '../../../auth/clerk/browser.ts';

// Only the deployment's static handshake configuration is isolate-scoped, never a request's identity or audit sink.
let browser: ReturnType<typeof clerkBrowserHandshakeFromEnv> | undefined;
// Bindings come from the Worker's env (adapter-cloudflare 8 drops platform.env).
export const handle = createHandle((request) => hostedServices(request, env), async (request) => {
	browser ??= clerkBrowserHandshakeFromEnv(env);
	return browser.ok ? handshakeResponse(await browser.handshake.handle(request)) : null;
});
export { handleError };
