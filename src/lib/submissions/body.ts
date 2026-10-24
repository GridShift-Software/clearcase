/**
 * Bounded incremental body reads. Content-Length is never trusted: the stream is read chunk by chunk and abandoned as
 * soon as it passes the bound, so no more than the bound plus one chunk is ever pulled, and nothing is buffered past it.
 */
export type BodyRead = { kind: 'ok'; bytes: Uint8Array } | { kind: 'too-large' } | { kind: 'incomplete' };

/**
 * A stream that errors (a dropped connection, an aborted request) is an interrupted body: `incomplete`, never a throw, and
 * nothing it delivered counts as received. Only the stream's own read and cancel are guarded: a fault in `onChunk` is ours
 * and still throws. The lock is always released and an over-long stream is cancelled, whether or not the cancel succeeds.
 */
async function drain(body: ReadableStream<Uint8Array> | null, limit: number, onChunk: (chunk: Uint8Array, at: number) => void): Promise<number | 'too-large' | 'incomplete'> {
  if (!body) return 0;
  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try { step = await reader.read(); } catch { return 'incomplete'; }
      if (step.done) return total;
      if (Object.prototype.toString.call(step.value) !== '[object Uint8Array]') return 'incomplete'; // not bytes: not a body we can bound
      if (total + step.value.byteLength > limit) {
        try { await reader.cancel(); } catch { /* the bytes are already refused; a failed cancel changes nothing */ }
        return 'too-large';
      }
      onChunk(step.value, total);
      total += step.value.byteLength;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* a stream that failed mid-read can refuse the release */ }
  }
}

/** Reads at most `limit` bytes; more is `too-large`. */
export async function readAtMost(body: ReadableStream<Uint8Array> | null, limit: number): Promise<BodyRead> {
  const chunks: Uint8Array[] = [];
  const total = await drain(body, limit, (c) => chunks.push(c));
  if (total === 'too-large' || total === 'incomplete') return { kind: total };
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return { kind: 'ok', bytes };
}

/** Reads exactly `size` bytes into one preallocated buffer: more is `too-large`, fewer (an interrupted body) is `incomplete`. */
export async function readExactly(body: ReadableStream<Uint8Array> | null, size: number): Promise<BodyRead> {
  const bytes = new Uint8Array(size);
  const total = await drain(body, size, (c, at) => bytes.set(c, at));
  if (total === 'too-large' || total === 'incomplete') return { kind: total };
  return total === size ? { kind: 'ok', bytes } : { kind: 'incomplete' };
}

/**
 * The minimal structural check of this slice: a PDF header at the first byte and an end-of-file marker in the last 1 KiB.
 * It refuses a file that is not a PDF or is visibly truncated; it does not validate or render the PDF.
 */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 8));
  if (!/^%PDF-[12]\.\d/.test(head)) return false;
  return new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.byteLength - 1024))).includes('%%EOF');
}
