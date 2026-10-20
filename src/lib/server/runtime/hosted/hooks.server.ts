import { env } from 'cloudflare:workers';
import { createHandle, handleError } from './handle.ts';
import { hostedServices } from './services.ts';

// The hosted production entry. Bindings come from the Worker's env (adapter-cloudflare 8 drops platform.env).
export const handle = createHandle((request) => hostedServices(request, env));
export { handleError };
