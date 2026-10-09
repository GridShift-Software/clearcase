// v5 spec: Deadlines (GRS-17). The deadline_order sweep adds synthetic deadlines out of date order, deletes the first
// shown row and exports the calendar, which shows S-deadlines_tab-1 (the wrong row deleted) and S-deadlines_tab-2 (the
// calendar format); the generic register_edit sweep adds in date order and cannot.
import { v5DeadlineOrder } from '../../../../../tests/e2e/registers/parity-driver.mjs';

export default { sweeps: [{ id: 'deadline_order', v5: v5DeadlineOrder }] };
