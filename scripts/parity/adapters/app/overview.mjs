// App adapter: Overview (the pilot's view, GRS-12). Maps the app's elements onto the v5 snapshot ids. The overview read
// and its tiles live in _shell.mjs (readOverviewSnapshot, readOverviewTiles), so other adapters' sweeps that end on the
// tiles read them the same way; a slot owner's plug-in (adapters/app/slots/<slot-id>.mjs) reads and seeds its slot.
import { seededUserWork } from '../../lib/sweeps.mjs';
import { navFocus, navList, readOverviewSnapshot, readOverviewTiles, slotPlugins } from './_shell.mjs';

export default {
	view: 'overview',
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/chronology', fromView: 'chronology', view: 'overview' });
		const out = await readOverviewSnapshot(p, ctx);
		out.lists.navigation = await navList(p);
		out.focus.after_nav = nav.focus;
		out.texts['shell.crumb'] = nav.crumb;
		return out;
	},
	sweeps: {
		/**
		 * v5 seeds synthetic deadlines and timesheet entries (seededUserWork(clock)), then reads every tile. Each slot
		 * plug-in enters the rows its slot needs through its owner's own UI (seed), the tiles are read under v5's labels,
		 * and every plug-in removes its rows again (cleanup, each in its own try, also when the read fails; the first
		 * error is rethrown); the tiles after cleanup must equal those before seeding. Without a plug-in nothing is
		 * seeded and the tiles are read as they are: the five that do not depend on that user work compare like the
		 * unseeded ones, and an unfilled slot by its wording.
		 */
		async seeded_user_work(p, ctx) {
			const plugins = [...(await slotPlugins(ctx)).values()];
			const rows = seededUserWork(ctx.clock);
			// with plug-ins, the tiles before seeding must equal the tiles after cleanup: seeded work must not leak
			// into later views of the run
			const before = plugins.length ? await readOverviewTiles(p, ctx) : null;
			const seeded = [];
			const errors = [];
			let tiles;
			try {
				for (const pl of plugins) { seeded.push(pl); await pl.seed(p, ctx, rows); }
				tiles = await readOverviewTiles(p, ctx);
			} catch (e) { errors.push(e); }
			// every cleanup runs, each in its own try; the first error of the sweep is rethrown
			for (const pl of seeded.reverse()) try { await pl.cleanup(p, ctx); } catch (e) { errors.push(e); }
			if (errors.length) throw errors[0];
			if (before) {
				const after = await readOverviewTiles(p, ctx);
				if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error(`seeded_user_work: the overview tiles after cleanup differ from those before seeding (before ${JSON.stringify(before)}, after ${JSON.stringify(after)}): make each slot plug-in's cleanup(p, ctx) remove everything its seed added`);
			}
			return Object.fromEntries(Object.entries(tiles).flatMap(([label, t]) => [[`${label}.value`, t.value], [`${label}.sub`, t.sub]]));
		},
	},
};
