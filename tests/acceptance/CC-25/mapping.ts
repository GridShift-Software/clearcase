// CC-25 item 3, source row to indexed original: each file row of the source export is compared, independently of the
// converter, with the asset the package indexes for its ref and with the original the reader verified. Pure, so
// mapping.test.ts can exercise it with invented rows.

export interface SourceRow { ref: string; url: unknown; declaredSize: unknown }
export interface IndexedAsset { kind: string; path?: string; size?: number; sha256?: string; parentRef?: string }
export interface VerifiedOriginal { path: string; sha256: string; size: number }

const decodeUrl = (u: unknown) => (typeof u === 'string' && u.startsWith('./') ? u.slice(2).split('/').map((s) => { try { return decodeURIComponent(s); } catch { return s; } }).join('/') : null);

/**
 * Each file row must agree with the package on three things, independently of the converter: the locator the source
 * names is the path the index holds, the size the source declares is the indexed size, and the original the reader
 * verified is at the indexed path. A mismatch fails; there are only two accounted exceptions, each counted by name in
 * the mapping: a locator with a `#fragment` that matches once the fragment is dropped (`pathNormalised`), and a row
 * whose source declares no size at all (`sizeUndeclared`).
 */
export function mapOriginals(rows: SourceRow[], assets: Record<string, IndexedAsset>, original: (ref: string) => VerifiedOriginal | undefined) {
  const mapping = {
    rows: rows.length, file: 0, fileWithParent: 0, embedded: 0, missing: 0, verified: 0, unavailable: 0,
    pathFromSourceUrl: 0, pathNormalised: 0, pathOther: 0, noLocator: 0, sizeAgrees: 0, sizeUndeclared: 0, sizeDiffers: 0, sizeInvalid: 0, realPathDiffers: 0,
  };
  const problems: string[] = [];
  rows.forEach((r, i) => {
    const a = assets[r.ref];
    if (!a) { problems.push(`row without an asset (${i})`); return; }
    if (a.kind === 'file') {
      mapping.file++;
      if (a.parentRef) mapping.fileWithParent++;
      const o = original(r.ref);
      if (o && o.sha256 === a.sha256 && o.size === a.size) mapping.verified++; else mapping.unavailable++;
      if (o && o.path !== a.path) mapping.realPathDiffers++;
      const located = decodeUrl(r.url);
      if (located === null) mapping.noLocator++;
      else if (located === a.path) mapping.pathFromSourceUrl++;
      else if (typeof r.url === 'string' && r.url.includes('#') && decodeUrl(r.url.slice(0, r.url.indexOf('#'))) === a.path) mapping.pathNormalised++;
      else mapping.pathOther++;
      if (typeof r.declaredSize === 'number') { if (r.declaredSize === a.size) mapping.sizeAgrees++; else mapping.sizeDiffers++; }
      else if (r.declaredSize === undefined || r.declaredSize === null) mapping.sizeUndeclared++;
      else mapping.sizeInvalid++;
    } else if (a.kind === 'missing') mapping.missing++;
  });
  mapping.embedded = Object.values(assets).filter((a) => a.kind === 'embedded').length;
  if (mapping.unavailable) problems.push(`${mapping.unavailable} indexed originals are not verified in the case folder`);
  if (mapping.noLocator) problems.push(`${mapping.noLocator} file rows have no "./" source locator to compare with the indexed path`);
  if (mapping.pathOther) problems.push(`${mapping.pathOther} file rows map to another path than their source locator names`);
  if (mapping.sizeDiffers) problems.push(`${mapping.sizeDiffers} file rows map to an original whose size differs from the size the source declares`);
  if (mapping.sizeInvalid) problems.push(`${mapping.sizeInvalid} file rows declare a size that is not a number`);
  if (mapping.realPathDiffers) problems.push(`${mapping.realPathDiffers} verified originals are at another path than the index names`);
  return { mapping, problems };
}
