// Unmigrated routes have an explicit hosted response; no request reaches the local route tree.
const unavailable = () => new Response('Hosted runtime is unavailable', { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '2', 'content-type': 'text/plain; charset=utf-8' } });
export const GET = unavailable;
export const HEAD = () => new Response(null, { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '2' } });
export const POST = unavailable;
export const PUT = unavailable;
export const PATCH = unavailable;
export const DELETE = unavailable;
export const OPTIONS = unavailable;
