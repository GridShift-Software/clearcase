/// <reference types="node" />
// Local deployment bridge, not part of the hosted request graph. Only this module's real filesystem checker can
// issue evidence. The pure binder remains useful for structural data comparisons; parents use bindCheckedNativeStages.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { nativeWalk, readNativeStage, readRegular } from '../probes/target.ts';
import { NATIVE_STAGED, parseNativePins, type NativePins } from './pipeline.ts';
import { NATIVE_STAGE_EVIDENCE_SCHEMA, bindNativeStages, sha256Text, type BindInput, type NativeArtifactBytes, type NativeBindingResult, type NativeStageEvidence } from './native-stage-binding.ts';

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
 * The actual final artifact bytes of `stage`, read through descriptors: exactly the checked upload inventory, each file's
 * size and hash equal to its inventory entry, and a tree listing with no file or directory the inventory does not imply.
 */
function artifactBytes(stage: string, inventory: readonly { path: string; bytes: number; sha256: string }[]): NativeArtifactBytes {
	const implied = new Set<string>();
	for (const f of inventory) {
		const parts = f.path.split('/');
		for (let i = 1; i <= parts.length; i++) implied.add(parts.slice(0, i).join('/'));
	}
	const listed = nativeWalk(path.join(stage, 'artifact')).map((e) => path.posix.join('artifact', e.rel.split(path.sep).join('/')));
	if (listed.length + 1 !== implied.size || !listed.every((p) => implied.has(p))) throw new Error('the staged artifact tree is not exactly the checked upload inventory (an unlisted file or an empty directory cannot be carried as byte evidence)');
	let entryText: string | undefined;
	const publicFiles: NativeArtifactBytes['publicFiles'] = [];
	for (const f of inventory) {
		const bytes = readRegular(path.join(stage, ...f.path.split('/')), stage);
		if (bytes.length !== f.bytes || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== f.sha256) throw new Error(`${f.path}: the bytes read are not the checked upload inventory's`);
		if (f.path === NATIVE_STAGED.entry) {
			entryText = bytes.toString('utf8');
			if (!bytes.equals(Buffer.from(entryText, 'utf8'))) throw new Error(`${f.path}: invalid UTF-8 is not entry text`);
		} else if (f.path.startsWith(`${NATIVE_STAGED.assets}/`)) publicFiles.push({ path: f.path, base64: bytes.toString('base64') });
		else throw new Error(`${f.path} is neither the Worker entry nor a public file`);
	}
	if (entryText === undefined) throw new Error(`${NATIVE_STAGED.entry} is not in the checked upload inventory`);
	return { entryText, publicFiles };
}

/**
 * Twice check the real stage with external pins, bracketing checked raw reads of the stage texts and of every artifact
 * byte in the checked upload inventory. readNativeStage.files contains HASHES, not texts. Both checked readings must
 * agree, and each raw text must hash to that reading and the external pins. Failed or changing stages throw and never
 * enter the private issuer set. No provider execution or readback is done.
 */
export function readNativeStageEvidence(a: { client: string; stage: string; clients: string; pins: NativePins; now: () => number }): NativeStageEvidence {
	const { client, stage, clients, now } = a;
	const parsed = parseNativePins(a.pins);
	if (!parsed.pins) throw new Error(parsed.problems.join('; '));
	const pins = freeze({ ...parsed.pins });
	const args = { client, stage, clients, pins };
	const before = readNativeStage(args);
	if (before.problems.length) throw new Error(before.problems.join('; '));
	if (!before.record) throw new Error('the checked reading has no stage record');
	const text = (file: string) => {
		const bytes = readRegular(path.join(stage, file), stage);
		const value = bytes.toString('utf8');
		if (!bytes.equals(Buffer.from(value, 'utf8'))) throw new Error(`${file}: invalid UTF-8 is not evidence text`);
		return value;
	};
	const files = { stageJson: text('stage.json'), targetJson: text('target.json'), configJsonc: text('wrangler.jsonc') };
	const artifact = artifactBytes(stage, before.record.upload.files);
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
	const evidence: NativeStageEvidence = freeze({ schema: NATIVE_STAGE_EVIDENCE_SCHEMA, checker: 'checkNativeStage', client, pins, problems: [], readAt, files, artifact });
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
