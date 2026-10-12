// App adapter: Deadlines (GRS-17). The register page read as a user sees it, v5's register_edit sweep and the
// deadline_order sweep (out-of-order entries, Delete on the first shown row, the calendar export) through the app's
// own form; the shared register driver lives in tests/e2e/registers/parity-driver.mjs.
import { fromRaw } from '../../lib/snapshot.mjs';
import { appDeadlineOrder, registerAdapter } from '../../../../tests/e2e/registers/parity-driver.mjs';
import { navFocus, readOverviewTiles } from './_shell.mjs';

export default registerAdapter('deadlines_tab', 'Export .ics', { fromRaw, navFocus, readOverviewTiles }, { deadline_order: appDeadlineOrder });
