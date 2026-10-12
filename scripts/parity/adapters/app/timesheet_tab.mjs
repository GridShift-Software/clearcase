// App adapter: Timesheet (GRS-17). The register page read as a user sees it and v5's register_edit sweep through the
// app's own form; the shared register driver lives in tests/e2e/registers/parity-driver.mjs.
import { fromRaw } from '../../lib/snapshot.mjs';
import { registerAdapter } from '../../../../tests/e2e/registers/parity-driver.mjs';
import { navFocus, readOverviewTiles } from './_shell.mjs';

export default registerAdapter('timesheet_tab', 'Export CSV', { fromRaw, navFocus, readOverviewTiles });
