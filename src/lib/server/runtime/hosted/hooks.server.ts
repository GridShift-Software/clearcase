import { createHandle, handleError } from './handle.ts';
import { hostedServices } from './services.ts';

// The hosted entry. Bindings come from the Worker's env per request (adapter-cloudflare 8 drops platform.env).
export const handle = createHandle(hostedServices);
export { handleError };
