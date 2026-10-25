// How a protected asset (an original, or a derived preview of a published results version) is released to the browser.
// The AssetsAccess handle decides authority, integrity, ranges, ETags and audit; this module decides only the
// presentation: inline for the in-app viewer, attachment for everything else.
//
// Inline is allowed only when ALL of these hold, otherwise the unchanged bytes are a download:
//   - the caller did not ask for ?download=1;
//   - the serve policy for the declared type is inline (PDF and common images; everything else is download-only);
//   - the request is a script fetch (`Sec-Fetch-Dest: empty`) or, for an image, an <img> (`image`). A navigation, frame,
//     embed or object load, or a client that names no destination, never renders the bytes in the application origin;
//   - the bytes' own head sniffs as the declared family (a PDF-named HTML file is a download, not a view).
// The sniffed head comes from one extra authorized, verified range read of the first KiB: the delivery handle exposes no
// content class. That read is audited by the handle like any other read-original (handoff: see docs/acceptance/native-viewer.md).
import type { AssetRef, AssetsAccess, ByteRequest } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';
import { contentContradictsType, servePolicy, sniffFamily } from '../../case-package/media.ts';

const INLINE_FAMILIES = new Set(['pdf', 'jpeg', 'png', 'gif', 'webp']);
const PROBE: ByteRequest = { method: 'GET', range: 'bytes=0-1023', ifRange: null };
/** The inline response never lets the document run: no script, no network, no framing. The viewer page reads it with fetch. */
export const INLINE_CSP = "sandbox; default-src 'none'; frame-ancestors 'none'";
const VARY = 'Range, Sec-Fetch-Dest';

export interface DeliveryInput { assets: AssetsAccess; asset: AssetRef; method: 'GET' | 'HEAD'; url: URL; headers: Headers }

const inlineDestination = (family: string, dest: string | null) => (family === 'pdf' ? dest === 'empty' : dest === 'empty' || dest === 'image');
const varied = (r: Response) => {
  const headers = new Headers(r.headers);
  headers.set('vary', VARY);
  return new Response(r.body, { status: r.status, headers });
};

export async function deliverAsset({ assets, asset, method, url, headers }: DeliveryInput): Promise<Response> {
  const request: ByteRequest = { method, range: headers.get('range'), ifRange: headers.get('if-range') };
  // Existence and authority first, with no byte read: an inaccessible asset reads as absent before anything is probed.
  const m = await assets.metadata({ asset });
  const policy = servePolicy(m.mediaType, m.filename);
  const dest = headers.get('sec-fetch-dest');
  const candidate = url.searchParams.get('download') !== '1' && policy.mode === 'inline-isolated' && (dest === 'empty' || dest === 'image');
  if (!candidate) return varied(await assets.get({ asset, request }));

  const probe = await assets.get({ asset, request: PROBE });
  if (probe.status >= 400 && probe.status !== 416) return varied(probe); // a refusal released nothing
  const head = probe.status === 416 ? new Uint8Array() : new Uint8Array(await probe.arrayBuffer());
  const family = sniffFamily(head);
  const inline = family !== null && INLINE_FAMILIES.has(family) && !contentContradictsType(m.mediaType, head) && inlineDestination(family, dest);

  const main = await assets.get({ asset, request });
  if (!inline || (main.status !== 200 && main.status !== 206)) return varied(main);
  // The object must be the one that was sniffed: a swap between the two reads is a failed integrity check, not a view.
  if (probe.headers.get('etag') === null || probe.headers.get('etag') !== main.headers.get('etag')) throw contractError('changed-original');
  const out = new Headers(main.headers);
  out.set('content-type', policy.headers['Content-Type']!);
  out.set('content-disposition', policy.headers['Content-Disposition']!);
  out.set('content-security-policy', INLINE_CSP);
  out.set('vary', VARY);
  return new Response(main.body, { status: main.status, headers: out });
}
