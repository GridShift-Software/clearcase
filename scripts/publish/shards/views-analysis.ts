import { localLoad } from '../local-loader.ts';
import type { ShardModule } from '../types.ts';

export default {
  name: 'views-analysis',
  async build(ctx) { return [
    ctx.json('view/matter.json', await localLoad(ctx, 'analysis/matter')),
    ctx.json('view/timeline.json', await localLoad(ctx, 'analysis/timeline')),
    ctx.json('view/contradictions_tab.json', await localLoad(ctx, 'analysis/contradictions_tab')),
    ctx.json('view/risk_matrix_tab.json', await localLoad(ctx, 'analysis/risk_matrix_tab')),
    ctx.json('view/vdm_matrix_tab.json', await localLoad(ctx, 'analysis/vdm_matrix_tab')),
    ctx.json('view/witness_tab.json', await localLoad(ctx, 'analysis/witness_tab')),
    ctx.json('view/people.json', await localLoad(ctx, 'evidence/people')),
    ctx.json('view/entity_ledger_tab.json', await localLoad(ctx, 'evidence/entity_ledger_tab')),
    ctx.json('view/conflict_tab.json', await localLoad(ctx, 'litigation/conflict_tab')),
  ]; },
} satisfies ShardModule;
