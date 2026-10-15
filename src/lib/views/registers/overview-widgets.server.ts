import type { OverviewWidgetLoader } from '../../components/overview-slots.ts';
import { now } from '../../components/clock.ts';
import type { LocalCase } from '../../local-case/service.server.ts';
import { listRegister } from '../../user-work/registers.server.ts';
import { REGISTERS } from './defs.ts';
import { openDeadlines, unbilledTime } from './logic.ts';

type Tile = { value: string; sub: string };

export const loaders: OverviewWidgetLoader<Tile, LocalCase>[] = [
	{ slot: 'deadlines', load: async ({ app, caseId }) => ({ value: String(openDeadlines(listRegister(app.userWork, caseId, REGISTERS.deadlines_tab), now())), sub: 'in the deadline tracker' }) },
	{ slot: 'unbilled-time', load: async ({ app, caseId }) => {
		const t = unbilledTime(listRegister(app.userWork, caseId, REGISTERS.timesheet_tab));
		return { value: t.value, sub: t.uncounted ? `recorded, not yet billed; ${t.uncounted} ${t.uncounted === 1 ? 'entry' : 'entries'} not counted (hours not a number)` : 'recorded, not yet billed' };
	} },
];
