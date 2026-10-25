// RED stub: the API only, nothing implemented.
import type { NativeManifest, ProviderReadback } from './controls.ts';
import type { NativePins } from './pipeline.ts';

export const NATIVE_STAGE_EVIDENCE_SCHEMA = 'clearcase.native-stage-evidence/1';
export const NATIVE_STAGE_BINDING_SCHEMA = 'clearcase.native-stage-binding/1';
export const STAGE_EVIDENCE_MAX_AGE_MS = 300_000;
export type NativeStageEvidence = { schema: typeof NATIVE_STAGE_EVIDENCE_SCHEMA; checker: 'checkNativeStage'; client: string; pins: NativePins; problems: string[]; readAt: number; files: { stageJson: string; targetJson: string; configJsonc: string } };
export type NativeStageReader = { read(client: string): NativeStageEvidence };
export type BindInput = { observed: { manifest: NativeManifest; readback: ProviderReadback }; pins: Record<string, NativePins>; profileRevision: string; reader: NativeStageReader; now: () => number };
export type NativeBindingResult = { state: string; problems: string[]; bound: unknown[]; structuralOnly: true; providerProof: false; controlReady: false; funded: false };
// RED baseline = a binder that checks nothing: it accepts whatever it is handed.
export function bindNativeStages(_a: BindInput): NativeBindingResult {
	return { state: 'BOUND-STRUCTURAL', problems: [], bound: [], structuralOnly: true, providerProof: false, controlReady: false, funded: false };
}
export function nativeBindingProblems(_x: unknown): string[] {
	return [];
}
