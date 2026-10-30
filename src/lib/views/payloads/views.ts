import type { ViewContentReader } from '../../case-package/view-content.ts';
import type { CaseStore } from '../../local-case/store.server.ts';
import type { FilingsShard } from '../evidence/filings.ts';
import type { AuthoritiesShard } from '../litigation/authorities.ts';
import type { CrossexamShard } from '../litigation/crossexam.ts';
import type { EnforcementShard } from '../litigation/enforcement.ts';
import type { InterestShard } from '../quantum/interest.ts';
import type { PaymentsShard } from '../quantum/payments.ts';
import type { SettlementShard } from '../quantum/settlement.ts';
import type { InfoRequiredShard } from './info-required.ts';
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

/**
 * The input of every pure loader half: the local store, the results version and its view-content reader. The operator
 * machine runs it against a local import of the package; it never reads user work.
 */
export interface PureInput {
	store: CaseStore;
	vid: string;
	vc: ViewContentReader;
	now?: () => Date;
}

/**
 * `view/<id>.json` by view id. A read-only view's shard is its loader's return value, except the two inputs the Worker
 * supplies: `prescription_tab.asOf` (the clock) and `vdm_matrix_tab.analysisAdditions` (false on hosted). A view that
 * mixes results with user work stores its pure half; its merge function adds the user work:
 *
 * | view | pure | merge |
 * | --- | --- | --- |
 * | `filings_tab` | `filingsPure` (`evidence/filings.server.ts`) | `filingsMerge` (`evidence/filings.ts`) |
 * | `payments_tab`, `interest_calc_tab`, `settlement_tab` | `paymentsPure`, `interestPure`, `settlementPure` (`quantum/data.server.ts`) | `paymentsMerge` (`quantum/payments.ts`), `interestMerge` (`quantum/interest.ts`), `settlementMerge` (`quantum/settlement.ts`) |
 * | `authorities_tab`, `crossexam_tab` | `authoritiesPure`, `crossexamPure` (`litigation/register.server.ts`) | `authoritiesMerge` (`litigation/authorities.ts`), `crossexamMerge` (`litigation/crossexam.ts`) |
 * | `enforcement_tab` | `enforcementPure` (`litigation/enforcement.server.ts`) | `enforcementMerge` (`litigation/enforcement.ts`) |
 * | `info_required_tab` | `infoRequiredPure` (`payloads/info-required.server.ts`) | `infoRequiredMerge` (`payloads/info-required.ts`) |
 *
 * The overview's pair is `overviewPure` (`overview/pure.server.ts`) and `overviewMerge` (`overview/merge.ts`). No merge
 * module imports `app()`, so the hosted loaders can import them.
 */
export interface ViewShards {
	matter: Matter;
	timeline: Timeline;
	contradictions_tab: Contradictions;
	risk_matrix_tab: RiskMatrix;
	vdm_matrix_tab: Omit<VdmMatrix, 'analysisAdditions'>;
	witness_tab: Witness;
	people: People;
	entity_ledger_tab: EntityLedger;
	contracts_tab: Contracts;
	conflict_tab: Conflict;
	elements_tab: Elements;
	legality_tab: Legality;
	quantum_tab: QuantumTab;
	invoice_ledger_tab: InvoiceLedger;
	prescription_tab: Omit<Prescription, 'asOf'>;
	filings_tab: FilingsShard;
	payments_tab: PaymentsShard;
	interest_calc_tab: InterestShard;
	settlement_tab: SettlementShard;
	authorities_tab: AuthoritiesShard;
	crossexam_tab: CrossexamShard;
	enforcement_tab: EnforcementShard;
	info_required_tab: InfoRequiredShard;
}

export type ShardViewId = keyof ViewShards;
