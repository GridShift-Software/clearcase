// Server-side reads shared by the analysis views (GRS-15): a dataset of the version being viewed, and which cited refs
// exist in it (a ref that does not exist renders broken; nothing is matched by similarity).
import { app } from '../local-case/app.server.ts';
import { citedRefs } from '../components/cite.ts';
import { datasetOf } from '../local-case/results.server.ts';

/** The `data` of a recognized dataset of this version, or null when the package lacks it. */
export const analysisDataset = <T>(resultsVersion: string, key: string): T | null => datasetOf<T>(app().store, resultsVersion, key);

/** Of these refs, the ones that name a document of this version (sorted; plain data for the page). */
export const existingOf = (resultsVersion: string, refs: Iterable<string>): string[] => [...app().store.existingRefs(resultsVersion, [...new Set(refs)])].sort();

/** The refs cited with [[REF]] tokens in these narrative texts that exist in this version. */
export const citedExisting = (resultsVersion: string, texts: Iterable<string>): string[] => existingOf(resultsVersion, citedRefs(texts));
