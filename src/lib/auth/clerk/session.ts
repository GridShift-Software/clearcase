// The cookie Clerk keeps a session token in on this deployment's origin. Kept apart from provider.ts so a route can name
// it without importing the Clerk SDK.
export const SESSION_COOKIE = '__session';
