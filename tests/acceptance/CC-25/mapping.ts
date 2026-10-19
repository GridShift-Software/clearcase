// CC-25 item 3, source row to indexed original: each file row of the source export is compared, independently of the
// converter, with the asset the package indexes for its ref and with the original the reader verified. Pure, so
// mapping.test.ts can exercise it with invented rows.

export interface SourceRow { ref: string; url: unknown; declaredSize: unknown }
export interface IndexedAsset { kind: string; path?: string; size?: number; sha256?: string; parentRef?: string }
export interface VerifiedOriginal { path: string; sha256: string; size: number }

const decodeUrl = (u: unknown) => (typeof u === 'string' && u.startsWith('./') ? u.slice(2).split('/').map((s) => { try { return decodeURIComponent(s); } catch { return s; } }).join('/') : null);

export function mapOriginals(rows: SourceRow[], assets: Record<string, IndexedAsset>, original: (ref: string) => VerifiedOriginal | undefined) {
  const mapping = { rows: rows.length, file: 0, fileWithParent: 0, embedded: 0, missing: 0, verified: 0, unavailable: 0, pathFromSourceUrl: 0, pathOther: 0, sizeAgrees: 0, sizeDiffers: 0, realPathDiffers: 0 };
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
      if (decodeUrl(r.url) === a.path) mapping.pathFromSourceUrl++; else mapping.pathOther++;
      if (typeof r.declaredSize === 'number') { if (r.declaredSize === a.size) mapping.sizeAgrees++; else mapping.sizeDiffers++; }
    } else if (a.kind === 'missing') mapping.missing++;
  });
  mapping.embedded = Object.values(assets).filter((a) => a.kind === 'embedded').length;
  if (mapping.unavailable) problems.push(`${mapping.unavailable} indexed originals are not verified in the case folder`);
  return { mapping, problems };
}
