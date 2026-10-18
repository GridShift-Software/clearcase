import { app } from '../local-case/app.server.ts';
import { citedRefs } from '../components/cite.ts';
import { resolveRefs } from '../local-case/documents.server.ts';
import { datasetOf } from '../local-case/results.server.ts';

export const analysisDataset = <T>(resultsVersion: string, key: string): T | null => datasetOf<T>(app().store, resultsVersion, key);

export const existingOf = (resultsVersion: string, refs: Iterable<string>): string[] => [...resolveRefs(app().store, resultsVersion, refs)].sort();

export const citedExisting = (resultsVersion: string, texts: Iterable<string>): string[] => existingOf(resultsVersion, citedRefs(texts));

// ADR 0003: an explicit preview opt-in is not client approval and never changes the default.
export const analysisAdditionsEnabled = () => process.env.CLEARCASE_ANALYSIS_ADDITIONS === '1';
