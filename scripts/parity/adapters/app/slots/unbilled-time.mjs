// Overview slot plug-in: Unbilled time (GRS-17). Reads the tile, and enters and removes the seeded synthetic time
// entries through the Timesheet register's own form.
import { slotPlugin } from '../../../../../tests/e2e/registers/parity-driver.mjs';

export default slotPlugin('unbilled-time', 'timesheet_tab', 'ess_dcs_timesheet_v1');
