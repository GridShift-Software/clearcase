import type { Handle, HandleServerError } from '@sveltejs/kit';
import { createUnavailableServices } from '../unavailable.ts';
import { id } from '../ids.ts';

// This staging entry has no trusted deployment bindings yet. Every protected adapter is unavailable.
export const handle: Handle = async ({ event, resolve }) => {
  Object.assign(event.locals, createUnavailableServices({ clientId: id('client', 'unconfigured'), now: () => new Date() }));
  if (!['GET', 'HEAD', 'OPTIONS'].includes(event.request.method) && event.request.headers.get('origin') !== event.url.origin)
    return new Response('Forbidden', { status: 403, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  const response = await resolve(event);
  response.headers.set('content-security-policy', "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  response.headers.set('cache-control', 'no-store');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'same-origin');
  response.headers.set('cross-origin-opener-policy', 'same-origin');
  response.headers.set('cross-origin-resource-policy', 'same-origin');
  return response;
};
export const handleError: HandleServerError = () => ({ message: 'Service unavailable' });
