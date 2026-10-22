// The parts of the Workers platform the storage probe uses, typed here because the repository's TypeScript run has no
// Workers types. Each shape is the documented binding API (D1 Worker API, R2 Workers API, Web Crypto's DigestStream).
export type D1Value = string | number | null | ArrayBuffer;
export interface D1Meta { rows_read: number; rows_written: number; changes: number; size_after: number; duration: number }
export interface D1Result<T> { results: T[]; meta: D1Meta }
export interface D1Statement {
	bind(...values: D1Value[]): D1Statement;
	first<T>(): Promise<T | null>;
	all<T>(): Promise<D1Result<T>>;
	run(): Promise<D1Result<never>>;
}
export interface D1 {
	prepare(sql: string): D1Statement;
	batch<T = Record<string, unknown>>(statements: D1Statement[]): Promise<D1Result<T>[]>;
}
export interface R2Object {
	key: string;
	size: number;
	etag: string;
	checksums: { sha256?: ArrayBuffer; md5?: ArrayBuffer };
	customMetadata?: Record<string, string>;
}
export interface R2ObjectBody extends R2Object {
	body: ReadableStream<Uint8Array>;
	arrayBuffer(): Promise<ArrayBuffer>;
	text(): Promise<string>;
}
export type R2Range = { offset: number; length?: number } | { suffix: number };
export interface R2GetOptions { range?: R2Range; onlyIf?: { etagMatches?: string } }
export interface R2PutOptions { sha256?: string; customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string }; onlyIf?: { etagDoesNotMatch?: string } }
export interface R2UploadedPart { partNumber: number; etag: string }
export interface R2MultipartUpload {
	key: string;
	uploadId: string;
	uploadPart(partNumber: number, value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string): Promise<R2UploadedPart>;
	complete(parts: R2UploadedPart[]): Promise<R2Object>;
	abort(): Promise<void>;
}
export interface R2 {
	head(key: string): Promise<R2Object | null>;
	get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | R2Object | null>;
	put(key: string, value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string, options?: R2PutOptions): Promise<R2Object | null>;
	delete(keys: string | string[]): Promise<void>;
	list(options?: { prefix?: string; cursor?: string; limit?: number; include?: ('customMetadata' | 'httpMetadata')[] }): Promise<{ objects: R2Object[]; truncated: boolean; cursor?: string }>;
	createMultipartUpload(key: string, options?: R2PutOptions): Promise<R2MultipartUpload>;
	resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
}
export interface Env { CLEARCASE_CLIENT_ID?: unknown; DB?: unknown; BUCKET?: unknown; PROBE_HOOKS?: unknown; CASE_DELETION_GUARD?: unknown }

/** workerd's streaming SHA-256 (`crypto.DigestStream`) and its fixed-length stream; neither is in the DOM library. */
interface DigestStream extends WritableStream<Uint8Array> { readonly digest: Promise<ArrayBuffer> }
const platform = globalThis as unknown as {
	crypto: { DigestStream: new (algorithm: 'SHA-256') => DigestStream };
	FixedLengthStream: new (length: number) => TransformStream<Uint8Array, Uint8Array>;
};
export const digestStream = () => new platform.crypto.DigestStream('SHA-256');
export const fixedLength = (length: number) => new platform.FixedLengthStream(length);
export const hasBody = (o: R2Object | R2ObjectBody | null): o is R2ObjectBody => o !== null && 'body' in o && o.body !== undefined;
export const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const sha256Hex = async (bytes: Uint8Array | string) => hex(await crypto.subtle.digest('SHA-256', typeof bytes === 'string' ? new TextEncoder().encode(bytes) : (bytes as Uint8Array<ArrayBuffer>)));
