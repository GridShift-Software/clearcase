// Server data of the registers' overview tiles (GRS-17). Open deadlines counts the case's dated deadlines not yet past
// (today counts), as v5 does; Unbilled time sums the hours of every entry not billed 'yes', parsing the Billed? flag
// explicitly (S-overview-1 corrected: v5 counted 'no' as billed). One bounded read of each register; plain data only.
import type { OverviewWidgetLoader } from '../../components/overview-slots.ts';
import { now } from '../../components/clock.ts';
import type { LocalCase } from '../../local-case/service.server.ts';
import { listRegister } from '../../user-work/registers.server.ts';
import { REGISTERS } from './defs.ts';
import { openDeadlines, unbilledHours } from './logic.ts';

type Tile = { value: string; sub: string };

export const loaders: OverviewWidgetLoader<Tile, LocalCase>[] = [
	{ slot: 'deadlines', load: async ({ app, caseId }) => ({ value: String(openDeadlines(listRegister(app.userWork, caseId, REGISTERS.deadlines_tab), now())), sub: 'in the deadline tracker' }) },
	{ slot: 'unbilled-time', load: async ({ app, caseId }) => ({ value: unbilledHours(listRegister(app.userWork, caseId, REGISTERS.timesheet_tab)), sub: 'recorded, not yet billed' }) },
];
