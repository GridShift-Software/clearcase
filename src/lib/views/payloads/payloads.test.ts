// Ticket 04: the shard types follow the local loaders. A read-only view's shard is its loader's return value; a mixed
// view's shard agrees with its loader on every field they share, and its merge returns exactly what the loader returns.
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

/** The shard's fields that the page data also has, with the page data's types. */
type Shared<Shard, Data> = Pick<Data, keyof Shard & keyof Data>;
type Own<Shard, Data> = Pick<Shard, keyof Shard & keyof Data>;

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

	it('mixed views: the loader returns what merge returns, and agrees with the shard on their shared fields', () => {
		expectTypeOf<Filings>().toEqualTypeOf<ReturnType<typeof filingsMerge>>();
		expectTypeOf<Shared<ViewShards['filings_tab'], Filings>>().toExtend<Own<ViewShards['filings_tab'], Filings>>();
		expectTypeOf<Payments>().toEqualTypeOf<ReturnType<typeof paymentsMerge>>();
		expectTypeOf<Shared<ViewShards['payments_tab'], Payments>>().toExtend<Own<ViewShards['payments_tab'], Payments>>();
		expectTypeOf<Interest>().toEqualTypeOf<ReturnType<typeof interestMerge>>();
		expectTypeOf<Shared<ViewShards['interest_calc_tab'], Interest>>().toExtend<Own<ViewShards['interest_calc_tab'], Interest>>();
		expectTypeOf<Settlement>().toEqualTypeOf<ReturnType<typeof settlementMerge>>();
		expectTypeOf<Shared<ViewShards['settlement_tab'], Settlement>>().toExtend<Own<ViewShards['settlement_tab'], Settlement>>();
		expectTypeOf<Authorities>().toEqualTypeOf<ReturnType<typeof authoritiesMerge>>();
		expectTypeOf<Shared<ViewShards['authorities_tab'], Authorities>>().toExtend<Own<ViewShards['authorities_tab'], Authorities>>();
		expectTypeOf<Crossexam>().toEqualTypeOf<ReturnType<typeof crossexamMerge>>();
		expectTypeOf<Shared<ViewShards['crossexam_tab'], Crossexam>>().toExtend<Own<ViewShards['crossexam_tab'], Crossexam>>();
		expectTypeOf<Enforcement>().toEqualTypeOf<ReturnType<typeof enforcementMerge>>();
		expectTypeOf<Shared<ViewShards['enforcement_tab'], Enforcement>>().toExtend<Own<ViewShards['enforcement_tab'], Enforcement>>();
		expectTypeOf<InfoRequired>().toEqualTypeOf<ReturnType<typeof infoRequiredMerge>>();
		expectTypeOf<Shared<ViewShards['info_required_tab'], InfoRequired>>().toExtend<Own<ViewShards['info_required_tab'], InfoRequired>>();
	});

	it('overview, shell and document shards follow their loaders', () => {
		expectTypeOf<Overview>().toEqualTypeOf<ReturnType<typeof overviewMerge>>();
		expectTypeOf<Omit<Overview, 'notes' | 'previous' | 'slots'>>().toEqualTypeOf<OverviewShard>();
		expectTypeOf<LayoutServerData['version']>().toEqualTypeOf<ShellShard['version']>();
		expectTypeOf<Pick<Doc, 'ref' | 'source' | 'fields' | 'state' | 'children' | 'related' | 'parent'>>().toExtend<Omit<DocShard, 'attachments' | 'assetIds' | 'mediaType' | 'originalState'>>();
		expectTypeOf<Omit<Doc['attachments'][number], 'links'>>().toExtend<DocShard['attachments'][number]>();
	});
});
