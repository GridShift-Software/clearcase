// The retained Clerk refresh adapter, tested independently of the new client app-session entry.
// Staff continues to use this protocol. Keep the original protocol assertions and counters intact.
import { env, waitUntil } from 'cloudflare:workers';
import { createHandle } from '../../../src/lib/server/runtime/hosted/handle.ts';
import { hostedServices } from '../../../src/lib/server/runtime/hosted/services.ts';
import { clerkBrowserHandshakeFromEnv, handshakeResponse } from '../../../src/lib/auth/clerk/browser.ts';
import { signInFormActionOrigins } from '../../../src/lib/auth/clerk/config.ts';
import { installNativeCompositions } from '../../../src/lib/server/runtime/hosted/compositions.ts';
import { withPinnedOrigin } from '../../../src/lib/server/runtime/hosted/origin-guard.ts';
import { legacyClerkProviderFromEnv } from './synthetic.ts';
installNativeCompositions();
let browser: ReturnType<typeof clerkBrowserHandshakeFromEnv> | undefined;
export const handle = withPinnedOrigin(() => env.CLEARCASE_APP_ORIGIN, createHandle(async (request, credential) => {
	const result = await hostedServices(request, env, { waitUntil: (work) => waitUntil(work) }, credential);
	const legacy = legacyClerkProviderFromEnv(env, { authorizeCase: async () => { throw new Error('No test grant'); } });
	if (legacy.ok) result.services.identity = await legacy.provider.authenticate({ request: credential ?? request });
	return result;
}, async (request) => {
	browser ??= clerkBrowserHandshakeFromEnv(env);
	return browser.ok ? handshakeResponse(await browser.handshake.handle(request)) : null;
}, (path) => signInFormActionOrigins(env, path), async (request) => {
	browser ??= clerkBrowserHandshakeFromEnv(env);
	return browser.ok ? browser.handshake.refresh(request) : null;
}, async (request, page) => {
	browser ??= clerkBrowserHandshakeFromEnv(env);
	return browser.ok ? browser.handshake.handoff(request, page) : null;
}));
