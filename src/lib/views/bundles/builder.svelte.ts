import { emptyBuilder, type Builder, type Output } from '../../bundles/builder.ts';
import type { Doc } from '../../bundles/pdf/index.ts';

export type BuiltOutput = Output & { pdf: Blob; url: string; saved: string | null };
export const bld = $state<{ b: Builder; msg: string; busy: boolean; prog: string; out: BuiltOutput | null; saving: boolean; saveError: string | null }>({
	b: emptyBuilder(), msg: '', busy: false, prog: '', out: null, saving: false, saveError: null,
});
export const docs = new Map<string, Doc>();
export const blobs = $state<Record<string, string>>({});

/** An output id: unique enough to key a saved bundle, without crypto.randomUUID (missing outside secure contexts). */
export function newId(): string {
	const a = crypto.getRandomValues(new Uint8Array(12));
	return 'o' + Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
}
