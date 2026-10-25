/**
 * The code of a closed core error, or null. Only an Error's OWN data property counts: an accessor, an inherited value, a
 * Proxy trap or any throw while looking is not read as classification, so caller-controlled objects run no code here.
 */
export function closedCode(e: unknown): string | null {
  try {
    if (!(e instanceof Error)) return null;
    const own = Object.getOwnPropertyDescriptor(e, 'code');
    return own && 'value' in own && typeof own.value === 'string' ? own.value : null;
  } catch { return null; }
}
