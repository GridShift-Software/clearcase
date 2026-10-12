// v5 spec: Annotations (GRS-17). The doc_ref_link sweep adds an entry whose Doc ref names the first document the chronology
// shows and one whose ref names nothing, and records whether each ref is a link (S-annotations_tab-1: v5 never links it).
import { v5DocRefLink } from '../../../../../tests/e2e/registers/parity-driver.mjs';

export default { sweeps: [{ id: 'doc_ref_link', v5: (p, ctx) => v5DocRefLink(p, ctx, 'annotations_tab', 'in_ess_dcs_annotations_v1_ref') }] };
