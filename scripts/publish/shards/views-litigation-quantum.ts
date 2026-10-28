import { localLoad } from '../local-loader.ts';
import type { ShardModule } from '../types.ts';
import type { ViewShards } from '../../../src/lib/views/payloads/views.ts';

export const routes = {
  elements_tab: 'litigation/elements_tab',
  legality_tab: 'litigation/legality_tab',
  contracts_tab: 'evidence/contracts_tab',
  quantum_tab: 'quantum/quantum_tab',
  invoice_ledger_tab: 'quantum/invoice_ledger_tab',
  prescription_tab: 'quantum/prescription_tab',
} satisfies Partial<Record<keyof ViewShards, string>>;

export default {
  name: 'views-litigation-quantum',
  async build(ctx) {
    const shards = [];
    for (const [id, route] of Object.entries(routes)) {
      const props = await localLoad(ctx, route);
      if (id === 'prescription_tab') delete props.asOf;
      shards.push(ctx.json(`view/${id}.json`, props));
    }
    return shards;
  },
} satisfies ShardModule;
