const LIST_TEXT = ['date', 'docType', 'bundle', 'subject', 'filename', 'sender', 'to', 'excerpt', 'amount', 'url', 'textStatus', 'preview'] as const;
const LIST_NULLABLE = ['dateType', 'dateSource', 'parentRef'] as const;
const FILE = new Set(['present', 'missing', 'blocked']);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v: unknown) => typeof v === 'string';
const isTextOrNull = (v: unknown) => v === null || typeof v === 'string';
export const validOriginal = (o: Record<string, unknown>) => typeof o.path === 'string' && o.path.length > 0 && Number.isSafeInteger(o.size) && (o.size as number) >= 0 &&
	typeof o.sha256 === 'string' && /^[0-9a-f]{64}$/.test(o.sha256) && typeof o.mediaType === 'string';

export function providerProblem(x: unknown): string | null {
	if (!isObject(x)) return 'not an object';
	if (typeof x.ref !== 'string' || !x.ref) return 'ref is not a non-empty string';
	// a lone surrogate survives the JSON copy but not encodeURIComponent, so a page linking to it would answer 500
	if (!x.ref.isWellFormed()) return 'ref is not well-formed Unicode';
	if (!isObject(x.row)) return 'row is not an object';
	const l = x.list, s = x.state;
	if (isObject(l) && l.ref !== x.ref) return 'the list entry names another ref';
	if (!isObject(l) || !LIST_TEXT.every((k) => isText(l[k])) || !LIST_NULLABLE.every((k) => isTextOrNull(l[k])) || !FILE.has(l.file as string) ||
		!Array.isArray(l.alsoIn) || !l.alsoIn.every(isText) || !Number.isFinite(l.attachments)) return 'list is not a chronology list entry';
	if (!isObject(s) || !FILE.has(s.file as string) || !isText(s.preview) || !isText(s.text) || !isTextOrNull(s.mediaType) || !Array.isArray(s.flags) ||
		!(s.original === null || isObject(s.original)) || !(s.self === null || isObject(s.self))) return 'state is not a document state';
	return null;
}
