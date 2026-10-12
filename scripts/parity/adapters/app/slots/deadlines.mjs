// Overview slot plug-in: Open deadlines (GRS-17). Reads the tile, and enters and removes the seeded synthetic deadlines
// through the Deadlines register's own form.
import { slotPlugin } from '../../../../../tests/e2e/registers/parity-driver.mjs';

export default slotPlugin('deadlines', 'deadlines_tab', 'ess_dcs_deadlines_v1');
