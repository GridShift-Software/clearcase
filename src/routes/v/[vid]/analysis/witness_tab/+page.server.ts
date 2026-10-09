import { analysisDataset, citedExisting } from '$lib/analysis/data.server';
import type { PageServerLoad } from './$types';

interface Witness { name: string; role: string; willsay: string }

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const witnesses = (analysisDataset<Witness[]>(version.id, 'witnesses') ?? []).map((w) => ({ name: w.name, role: w.role, willsay: w.willsay }));
	// a will-say is authored narrative: its [[REF]] citations link to documents of this version, nothing else does
	return { witnesses, known: citedExisting(version.id, witnesses.map((w) => w.willsay)) };
};
