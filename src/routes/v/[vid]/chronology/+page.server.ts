import { app } from '$lib/local-case/app.server';
import { exportFileName, viewContentOf } from '$lib/local-case/results.server';
import type { PageServerLoad } from './$types';

// The export's file name is case content v5 hard-coded in its chronology export (GRS-38): read from the package's
// view-content (`chronology.exportFileName`), else the neutral name with a note. The parent layout has verified the
// version; the dataset is cached per version, so warm navigation stays one small data request beside the 304 list.
export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	return { exportName: exportFileName(viewContentOf(app().store, version.id), 'chronology', 'chronology.csv') };
};
