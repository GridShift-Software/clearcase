// The Court Bundle builder's session state (v5 CBBLD and CBBLOB): the picked files, their parsed documents, the items,
// the last output and the PDFs of bundles saved this session. Like v5, it survives moving around the app and is gone on
// reload: the PDFs are never uploaded or stored, only the saved bundle's item list is (user work).
import { emptyBuilder, type Builder, type Output } from '../../bundles/builder.ts';
import type { Doc } from '../../bundles/pdf/index.ts';

export type BuiltOutput = Output & { url: string; saved: string | null };
export const bld = $state<{ b: Builder; msg: string; busy: boolean; prog: string; out: BuiltOutput | null; saving: boolean; saveError: string | null }>({
	b: emptyBuilder(), msg: '', busy: false, prog: '', out: null, saving: false, saveError: null,
});
/** Parsed documents by file id (not reactive: large and never rendered). */
export const docs = new Map<string, Doc>();
/** The session PDF of each bundle saved from the builder, by its output id (v5 CBBLOB, which keyed by number). */
export const blobs = $state<Record<string, string>>({});

/** An output id: unique enough to key a saved bundle, without crypto.randomUUID (missing outside secure contexts). */
export function newId(): string {
	const a = crypto.getRandomValues(new Uint8Array(12));
	return 'o' + Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
}
