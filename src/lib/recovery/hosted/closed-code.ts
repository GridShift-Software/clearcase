/**
 * The code of a closed core error, or null. Only an Error's OWN data property counts: an accessor, an inherited value, a
 * coercible object or any throw while looking is not read as classification, and nothing here coerces or calls a value.
 * A Proxy is not detected. Standard JS has no check that runs none of its traps, and `util.types.isProxy` is not available in
 * workerd, so `instanceof` and the descriptor read may run a Proxy's `getPrototypeOf` and `getOwnPropertyDescriptor` traps.
 * That is accepted because thrown values come from core and port code, not from a request, and the most a Proxy can select is
 * a code in the caller's table, which has a fixed text and only a 4xx or 5xx status. A throwing trap is null here.
 */
export function closedCode(e: unknown): string | null {
  try {
    if (!(e instanceof Error)) return null;
    const own = Object.getOwnPropertyDescriptor(e, 'code');
    return own && 'value' in own && typeof own.value === 'string' ? own.value : null;
  } catch { return null; }
}
