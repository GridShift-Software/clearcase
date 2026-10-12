// App adapter: Annotations (GRS-17). The register page read as a user sees it, v5's register_edit sweep and the doc_ref_link
// sweep (a typed ref naming an imported document links to it; one naming nothing does not) through the app's own form;
// the shared register driver lives in tests/e2e/registers/parity-driver.mjs.
import { fromRaw } from '../../lib/snapshot.mjs';
import { appDocRefLink, registerAdapter } from '../../../../tests/e2e/registers/parity-driver.mjs';
import { navFocus, readOverviewTiles } from './_shell.mjs';

export default registerAdapter('annotations_tab', 'Export CSV', { fromRaw, navFocus, readOverviewTiles }, { doc_ref_link: (p, ctx) => appDocRefLink(p, ctx, 'annotations_tab') });
