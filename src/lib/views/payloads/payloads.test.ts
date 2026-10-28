// Ticket 04: the shard types follow the local loaders. A read-only view's shard is its loader's return value; a mixed
// view's shard is its page data less the fields its merge declares it replaces or adds, and its merge returns the loader's value.
// Checked by tsc (`bunx tsc --noEmit -p .`); the runtime assertions only keep Vitest collecting the file.
import { describe, expectTypeOf, it } from 'vitest';
import type { ShellShard, ViewShards, DocShard, OverviewShard } from '../payloads.ts';
import type { LayoutServerData } from '../../../routes/v/[vid]/$types';
import type { PageServerData as Doc } from '../../../routes/v/[vid]/doc/[ref]/$types';
import type { PageServerData as Matter } from '../../../routes/v/[vid]/analysis/matter/$types';
import type { PageServerData as Timeline } from '../../../routes/v/[vid]/analysis/timeline/$types';
import type { PageServerData as Contradictions } from '../../../routes/v/[vid]/analysis/contradictions_tab/$types';
import type { PageServerData as RiskMatrix } from '../../../routes/v/[vid]/analysis/risk_matrix_tab/$types';
import type { PageServerData as VdmMatrix } from '../../../routes/v/[vid]/analysis/vdm_matrix_tab/$types';
import type { PageServerData as Witness } from '../../../routes/v/[vid]/analysis/witness_tab/$types';
import type { PageServerData as People } from '../../../routes/v/[vid]/evidence/people/$types';
import type { PageServerData as EntityLedger } from '../../../routes/v/[vid]/evidence/entity_ledger_tab/$types';
import type { PageServerData as Contracts } from '../../../routes/v/[vid]/evidence/contracts_tab/$types';
import type { PageServerData as Conflict } from '../../../routes/v/[vid]/litigation/conflict_tab/$types';
import type { PageServerData as Elements } from '../../../routes/v/[vid]/litigation/elements_tab/$types';
import type { PageServerData as Legality } from '../../../routes/v/[vid]/litigation/legality_tab/$types';
import type { PageServerData as QuantumTab } from '../../../routes/v/[vid]/quantum/quantum_tab/$types';
import type { PageServerData as InvoiceLedger } from '../../../routes/v/[vid]/quantum/invoice_ledger_tab/$types';
import type { PageServerData as Prescription } from '../../../routes/v/[vid]/quantum/prescription_tab/$types';
import type { PageServerData as Filings } from '../../../routes/v/[vid]/evidence/filings_tab/$types';
import type { PageServerData as Payments } from '../../../routes/v/[vid]/quantum/payments_tab/$types';
import type { PageServerData as Interest } from '../../../routes/v/[vid]/quantum/interest_calc_tab/$types';
import type { PageServerData as Settlement } from '../../../routes/v/[vid]/quantum/settlement_tab/$types';
import type { PageServerData as Authorities } from '../../../routes/v/[vid]/litigation/authorities_tab/$types';
import type { PageServerData as Crossexam } from '../../../routes/v/[vid]/litigation/crossexam_tab/$types';
import type { PageServerData as Enforcement } from '../../../routes/v/[vid]/litigation/enforcement_tab/$types';
import type { PageServerData as InfoRequired } from '../../../routes/v/[vid]/analysis/info_required_tab/$types';
import type { PageServerData as Overview } from '../../../routes/v/[vid]/overview/$types';
import type { filingsMerge } from '../evidence/filings.ts';
import type { paymentsMerge } from '../quantum/payments.ts';
import type { interestMerge } from '../quantum/interest.ts';
import type { settlementMerge } from '../quantum/settlement.ts';
import type { authoritiesMerge } from '../litigation/authorities.ts';
import type { crossexamMerge } from '../litigation/crossexam.ts';
import type { enforcementMerge } from '../litigation/enforcement.ts';
import type { infoRequiredMerge } from './info-required.ts';
import type { overviewMerge } from '../overview/merge.ts';

/**
 * A mixed view's contract with its loader. `Replaced` names the shard fields the merge consumes or rewrites, and `Added`
 * the page fields the merge introduces. Everything else must be the same field with the same type on both sides, so a
 * shard field missing from the page, a page field the shard does not carry, or an undeclared type change all fail.
 */
type Rest<T, K extends keyof T> = Omit<T, K>;

describe('payload types', () => {
	it('read-only views: each loader return is assignable to its shard', () => {
		expectTypeOf<Matter>().toExtend<ViewShards['matter']>();
		expectTypeOf<Timeline>().toExtend<ViewShards['timeline']>();
		expectTypeOf<Contradictions>().toExtend<ViewShards['contradictions_tab']>();
		expectTypeOf<RiskMatrix>().toExtend<ViewShards['risk_matrix_tab']>();
		expectTypeOf<VdmMatrix>().toExtend<ViewShards['vdm_matrix_tab']>();
		expectTypeOf<Witness>().toExtend<ViewShards['witness_tab']>();
		expectTypeOf<People>().toExtend<ViewShards['people']>();
		expectTypeOf<EntityLedger>().toExtend<ViewShards['entity_ledger_tab']>();
		expectTypeOf<Contracts>().toExtend<ViewShards['contracts_tab']>();
		expectTypeOf<Conflict>().toExtend<ViewShards['conflict_tab']>();
		expectTypeOf<Elements>().toExtend<ViewShards['elements_tab']>();
		expectTypeOf<Legality>().toExtend<ViewShards['legality_tab']>();
		expectTypeOf<QuantumTab>().toExtend<ViewShards['quantum_tab']>();
		expectTypeOf<InvoiceLedger>().toExtend<ViewShards['invoice_ledger_tab']>();
		expectTypeOf<Prescription>().toExtend<ViewShards['prescription_tab']>();
	});

	it('mixed views: the loader returns what merge returns, and the shard is the page data less the declared merge work', () => {
		expectTypeOf<Filings>().toEqualTypeOf<ReturnType<typeof filingsMerge>>();
		expectTypeOf<Rest<Filings, 'entries' | 'files' | 'editing'>>().toEqualTypeOf<Rest<ViewShards['filings_tab'], 'fileOf'>>();
		expectTypeOf<Payments>().toEqualTypeOf<ReturnType<typeof paymentsMerge>>();
		expectTypeOf<Rest<Payments, 'payments'>>().toEqualTypeOf<ViewShards['payments_tab']>();
		expectTypeOf<Interest>().toEqualTypeOf<ReturnType<typeof interestMerge>>();
		expectTypeOf<Rest<Interest, 'paymentDates'>>().toEqualTypeOf<ViewShards['interest_calc_tab']>();
		expectTypeOf<Settlement>().toEqualTypeOf<ReturnType<typeof settlementMerge>>();
		expectTypeOf<Rest<Settlement, 'claim' | 'payments'>>().toEqualTypeOf<Rest<ViewShards['settlement_tab'], 'claimDate' | 'importedClaim'>>();
		expectTypeOf<Authorities>().toEqualTypeOf<ReturnType<typeof authoritiesMerge>>();
		expectTypeOf<Rest<Authorities, 'addId' | 'user'>>().toEqualTypeOf<ViewShards['authorities_tab']>();
		expectTypeOf<Crossexam>().toEqualTypeOf<ReturnType<typeof crossexamMerge>>();
		expectTypeOf<Rest<Crossexam, 'known' | 'rows' | 'addId'>>().toEqualTypeOf<Rest<ViewShards['crossexam_tab'], 'knownSeedRefs'>>();
		expectTypeOf<Enforcement>().toEqualTypeOf<ReturnType<typeof enforcementMerge>>();
		expectTypeOf<Rest<Enforcement, 'rows'>>().toEqualTypeOf<Rest<ViewShards['enforcement_tab'], 'rows'>>();
		expectTypeOf<InfoRequired>().toEqualTypeOf<ReturnType<typeof infoRequiredMerge>>();
		expectTypeOf<Rest<InfoRequired, 'detached'>>().toEqualTypeOf<ViewShards['info_required_tab']>();
	});

	it('mixed views: the contract check catches a missing field and an undeclared type change', () => {
		// Page data that lost one of the shard's fields.
		// @ts-expect-error narrative is on the settlement shard but not on this page data
		expectTypeOf<Rest<Omit<Settlement, 'narrative'>, 'claim' | 'payments'>>().toEqualTypeOf<Rest<ViewShards['settlement_tab'], 'claimDate' | 'importedClaim'>>();
		// The merge rewrites enforcement's rows; leaving that undeclared must fail rather than pass on the shared key.
		// @ts-expect-error the page's rows are not the shard's rows
		expectTypeOf<Enforcement>().toEqualTypeOf<ViewShards['enforcement_tab']>();
	});

	it('overview, shell and document shards follow their loaders', () => {
		expectTypeOf<Overview>().toEqualTypeOf<ReturnType<typeof overviewMerge>>();
		expectTypeOf<Omit<Overview, 'notes' | 'previous' | 'slots'>>().toEqualTypeOf<OverviewShard>();
		expectTypeOf<LayoutServerData['version']>().toEqualTypeOf<ShellShard['version']>();
		expectTypeOf<Pick<Doc, 'ref' | 'source' | 'fields' | 'state' | 'children' | 'related' | 'parent'>>().toExtend<Omit<DocShard, 'attachments' | 'assetIds' | 'mediaType' | 'originalState'>>();
		expectTypeOf<Omit<Doc['attachments'][number], 'links'>>().toExtend<DocShard['attachments'][number]>();
	});
});
