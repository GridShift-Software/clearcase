/// <reference types="node" />
// Local deployment bridge, not part of the hosted request graph. Only this module's real filesystem checker can
// issue evidence. The pure binder remains useful for structural data comparisons; parents use bindCheckedNativeStages.
import path from 'node:path';
import { readNativeStage, readRegular } from '../probes/target.ts';
import { parseNativePins, type NativePins } from './pipeline.ts';
import { bindNativeStages, sha256Text, type BindInput, type NativeBindingResult, type NativeStageEvidence } from './native-stage-binding.ts';

const ISSUED = new WeakSet<object>();
const freeze = <T>(value: T): T => {
	if (value && typeof value === 'object') {
		for (const v of Object.values(value)) freeze(v);
		Object.freeze(value);
	}
	return value;
};

/** No caller checker label, boolean, spread or stored JSON confers this process-local origin. */
export function isIssuedNativeStageEvidence(value: unknown): value is NativeStageEvidence {
	return typeof value === 'object' && value !== null && ISSUED.has(value);
}

/**
 * Twice check the real stage with external pins, bracketing checked raw reads. readNativeStage.files contains HASHES,
 * not texts. Both checked readings must agree, and each raw text must hash to that reading and the external pins.
 * Failed or changing stages throw and never enter the private issuer set. No provider execution or readback is done.
 */
export function readNativeStageEvidence(a: { client: string; stage: string; clients: string; pins: NativePins; now: () => number }): NativeStageEvidence {
	const { client, stage, clients, now } = a;
	const parsed = parseNativePins(a.pins);
	if (!parsed.pins) throw new Error(parsed.problems.join('; '));
	const pins = freeze({ ...parsed.pins });
	const args = { client, stage, clients, pins };
	const before = readNativeStage(args);
	if (before.problems.length) throw new Error(before.problems.join('; '));
	const text = (file: string) => {
		const bytes = readRegular(path.join(stage, file), stage);
		const value = bytes.toString('utf8');
		if (!bytes.equals(Buffer.from(value, 'utf8'))) throw new Error(`${file}: invalid UTF-8 is not evidence text`);
		return value;
	};
	const files = { stageJson: text('stage.json'), targetJson: text('target.json'), configJsonc: text('wrangler.jsonc') };
	const after = readNativeStage(args);
	if (after.problems.length) throw new Error(after.problems.join('; '));
	if (!before.files || !before.record || !after.files || !after.record || JSON.stringify(before) !== JSON.stringify(after)) throw new Error('the checked stage changed between the two evidence readings');
	for (const key of ['stageJson', 'targetJson', 'configJsonc'] as const) {
		if (sha256Text(files[key]) !== before.files[key]) throw new Error(`${key}: raw text differs from the checked reading`);
	}
	if (sha256Text(files.targetJson) !== pins.target || sha256Text(files.configJsonc) !== pins.config) throw new Error('raw target/config texts do not match the external pins');
	if (files.stageJson !== `${JSON.stringify(before.record, null, 2)}\n`) throw new Error('raw stage text is not the recomputed checked record');
	const readAt = now();
	if (!Number.isFinite(readAt)) throw new Error('evidence completion clock is not finite');
	const evidence: NativeStageEvidence = freeze({ schema: 'clearcase.native-stage-evidence/1', checker: 'checkNativeStage', client, pins, problems: [], readAt, files });
	ISSUED.add(evidence);
	return evidence;
}

/** Mandatory parent bridge: verify real issuer identity BEFORE the pure binder copies or judges evidence data. */
export function bindCheckedNativeStages(a: BindInput): NativeBindingResult {
	const reader = a.reader;
	return bindNativeStages({ ...a, reader: { read(client) {
		const evidence = reader.read(client);
		if (!isIssuedNativeStageEvidence(evidence)) throw new Error('stage evidence was not issued by readNativeStageEvidence in this process');
		return evidence;
	} } });
}
