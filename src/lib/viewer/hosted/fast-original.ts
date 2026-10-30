import type { AssetRef, AssetsAccess, ByteRequest } from '../../server/runtime/contracts';
import type { AssetTicket, TicketClaims } from './ticket';
export type OriginalRow = TicketClaims & { objectKey: string };
export interface FastOriginals {
 locate(asset: AssetRef): Promise<OriginalRow>;
 record(asset: AssetRef, outcome: 'succeeded'|'failed'|'refused'): void;
 get(asset: AssetRef, request: ByteRequest, ticket?: AssetTicket): Promise<Response>;
}
const handles = new WeakMap<AssetsAccess,FastOriginals>();
export const registerFastOriginals = (assets: AssetsAccess, handle: FastOriginals) => { handles.set(assets,handle); return assets; };
export const fastOriginals = (assets: AssetsAccess) => handles.get(assets);
