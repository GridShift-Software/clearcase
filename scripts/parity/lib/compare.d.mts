// Types for compare.mjs.
import type { Snapshot } from './snapshot.mjs';
export const ABSENT: '<absent>';
export const TYPES: readonly ['improvement', 'defect-fix', 'data-correction-deferred-to-pipeline', 'not-yet-implemented', 'known-gap'];
export type DiffType = (typeof TYPES)[number];
export interface Difference { path: string; kind: 'value' | 'v5-only' | 'app-only' | 'order' | 'view-not-implemented' | 'extract-error'; v5: string; app: string; index?: number; v5Length?: number; appLength?: number }
export interface Entry { id: string; view: string; field: string | string[]; when?: { v5?: string | { re: string }; app?: string | { re: string } }; type: DiffType; source?: string; owner?: string; reason: string; productVisible: boolean; author: string; approvedBy: string | null; approvedOn: string | null }
export interface Result { compared: number; matched: number; v5Values: number; appValues: number; diffs: Difference[] }
export interface Classified extends Result { registered: (Difference & { register: string; type: DiffType; approved: boolean })[]; unregistered: Difference[] }
export function flatten(s: Snapshot): Map<string, string>;
export function diff(v5: Snapshot, app: Snapshot): Result;
export function covering(entries: readonly Entry[], view: string, d: { path: string; v5?: string; app?: string; kind?: string }, opts?: { approvedOnly?: boolean }): Entry | null;
export function classify(view: string, result: Result, entries: readonly Entry[], opts?: { approvedOnly?: boolean }): Classified;
export function scorecard(perView: Record<string, Classified & { v5Status: string; appStatus: string; ms?: number }>, meta?: Record<string, unknown>): any;
export function runFailures(sc: { total: { unregistered: number; viewsExtractedV5: number; viewsExtractError?: number }; isolation?: { v5NonFileRequests?: number | null; appNonLoopbackRequests?: number | null; canaryHits?: number; fixtureUnchanged?: boolean } }, opts: { views: number; unused?: number; strict?: boolean }): string[];
