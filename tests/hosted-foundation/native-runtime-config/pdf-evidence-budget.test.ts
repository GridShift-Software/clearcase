// U14 item 5. The scaled PDF evidence budget (U9) as deployment settings: the planner accepts exactly the checker's own rules, emits the
// budget unchanged, refuses it without the Browser opt-in, and plans each PDF session's whole lease on the same Browser allocation.
import { describe, expect, it } from 'vitest';
import { planNativeRuntimeConfig } from '../../../deploy/native-alpha/runtime-config.ts';
import { NATIVE_PDF_EVIDENCE_CEILINGS } from '../../../src/lib/viewer/hosted/native-render-check.ts';
import { exampleInput, exampleWithBrowserAllocation } from './example-input.ts';
import { nativeConfigOf } from './harness.ts';

const PDF = { ...NATIVE_PDF_EVIDENCE_CEILINGS };
/** A PDF session's lease: its deadline, 2 s of cleanup and the provider's 60 s idle tail (migration 0004's lease_ms). */
const LEASE = PDF.maxSessionMs + 2_000 + 60_000;
/** Client B with renders (67,000 ms a day) and the full PDF budget; client A as the example has it (144,000 ms a day). */
function withPdf(budget: Record<string, number> = PDF, allocation = { maxConcurrentBrowsers: 3, maxReservedBrowserMsPerDay: 144_000 + 67_000 + LEASE * PDF.maxSessionsPerClientPerDay }) {
	const input = exampleWithBrowserAllocation();
	(input.clients[1]!.policy as Record<string, unknown>).pdfEvidenceBudget = budget;
	input.browserAllocation = allocation;
	return input;
}

describe('pdfEvidenceBudget in the native runtime planner (U14)', () => {
	it('emits the budget unchanged and plans two browsers and every session lease for that client', () => {
		const plan = planNativeRuntimeConfig(withPdf());
		expect(nativeConfigOf(plan.clients[1]!).pdfEvidenceBudget).toEqual(PDF);
		expect(nativeConfigOf(plan.clients[0]!).pdfEvidenceBudget).toBeUndefined();
		const b = plan.manifest.plannedBrowserAllocation!.clients.find((c) => c.clientId === 'client-b')!;
		expect(b).toMatchObject({ maxConcurrentBrowsers: 2, pdfSessionLeaseMs: LEASE, maxPdfSessionsPerClientPerDay: 96, reservedMsPerDay: 67_000 + LEASE * 96 });
		expect(plan.manifest.plannedBrowserAllocation!.totals).toEqual({ concurrentBrowsers: 3, reservedMsPerDay: 144_000 + 67_000 + LEASE * 96 });
	});
	it('refuses an allocation the sessions do not fit, by browsers or by reserved time', () => {
		expect(() => planNativeRuntimeConfig(withPdf(PDF, { maxConcurrentBrowsers: 2, maxReservedBrowserMsPerDay: 10_000_000 }))).toThrow(/exceed the explicit aggregate policy/);
		expect(() => planNativeRuntimeConfig(withPdf(PDF, { maxConcurrentBrowsers: 3, maxReservedBrowserMsPerDay: 211_000 + LEASE * 96 - 1 }))).toThrow(/exceed the explicit aggregate policy/);
	});
	it('refuses the budget without a nativeRenderBudget, the Browser opt-in', () => {
		const input = exampleInput();
		(input.clients[1]!.policy as Record<string, unknown>).pdfEvidenceBudget = PDF;
		expect(() => planNativeRuntimeConfig(input)).toThrow(/requires a nativeRenderBudget/);
	});
	it.each([
		['a value over its ceiling', { ...PDF, maxSessionMs: PDF.maxSessionMs + 1 }, /within the renderer ceiling/],
		['a zero', { ...PDF, maxRendersPerSession: 0 }, /within the renderer ceiling/],
		['a fraction', { ...PDF, maxDocumentMs: 1.5 }, /within the renderer ceiling/],
		['a missing key', (({ maxSessionBytes: _m, ...rest }) => rest)(PDF), /missing, unknown and defaulted fields are refused/],
		['an extra key', { ...PDF, maxPages: 4 }, /missing, unknown and defaulted fields are refused/],
		['a document longer than its session', { ...PDF, maxDocumentMs: 20_000, maxSessionMs: 20_500 }, /must fit its session/],
		['a file larger than its session bytes', { ...PDF, maxSessionBytes: PDF.maxFileBytes - 1 }, /must fit its session/],
		['more renders a session than documents a step', { ...PDF, maxDocumentsPerStep: 31 }, /must fit its session/],
	])('refuses %s', (_name, budget, message) => {
		expect(() => planNativeRuntimeConfig(withPdf(budget as Record<string, number>))).toThrow(message);
	});
});
