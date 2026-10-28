import { env, waitUntil } from 'cloudflare:workers';
import { createHandle, handleError } from './handle.ts';
import { hostedServices } from './services.ts';
import { clerkBrowserHandshakeFromEnv, handshakeAnswer } from '../../../auth/clerk/browser.ts';
import { signInFormActionOrigins } from '../../../auth/clerk/config.ts';
import { installNativeCompositions } from './compositions.ts';
import { withPinnedOrigin } from './origin-guard.ts';
import { clerkBrowserNeeded, appSessionRefresh } from '../../../auth/app-browser.ts';
installNativeCompositions();

// Only the deployment's static handshake configuration is isolate-scoped, never a request's identity or audit sink.
let browser: ReturnType<typeof clerkBrowserHandshakeFromEnv> | undefined;
// Bindings come from the Worker's env and post-response work from the runtime's waitUntil, which extends the invocation
// that calls it: adapter-cloudflare 8 passes no platform, so there is no platform.env or platform.context.
// Clerk session tokens live a minute and no clerk-js runs here, so a request that is not a document renews an expired
// session on the Worker (browser.ts refresh); a document still renews it through the handshake, and a page-data request
// that cannot be renewed is handed to a full page load through it (browser.ts handoff).
// One Worker serves one origin: a request at any other origin is refused, for every method, before identity or routing.
export const handle = withPinnedOrigin(() => env.CLEARCASE_APP_ORIGIN, createHandle((request, credential) => hostedServices(request, env, { waitUntil: (work) => waitUntil(work) }, credential), async (request) => {
	if (!clerkBrowserNeeded(env, request)) return null;
	browser ??= clerkBrowserHandshakeFromEnv(env);
	return browser.ok ? handshakeAnswer(await browser.handshake.handle(request)) : null;
}, (path) => signInFormActionOrigins(env, path), async (request) => {
	const app = await appSessionRefresh(env, request);
	if (app) return app;
	if (!clerkBrowserNeeded(env, request)) return null;
	browser ??= clerkBrowserHandshakeFromEnv(env);
	return browser.ok ? browser.handshake.refresh(request) : null;
}, async (request, page) => {
	if (!clerkBrowserNeeded(env, request)) return null;
	browser ??= clerkBrowserHandshakeFromEnv(env);
	return browser.ok ? browser.handshake.handoff(request, page) : null;
}));
export { handleError };
