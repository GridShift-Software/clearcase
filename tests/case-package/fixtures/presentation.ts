import type { SynthRoots } from './synth';

/** Additional registered datasets for schema exhaustiveness tests; do not change the v5 fixture. */
export function withPresentation(r: SynthRoots): void {
	r.DATA.anchors = [{ ref: 'OD-001', issue: 'Synthetic issue', why: 'Synthetic reason', page: 1 }];
	r.DATA.organogram = { nodes: [{ id: 'a', label: 'Synthetic organisation' }], edges: [] };
}
