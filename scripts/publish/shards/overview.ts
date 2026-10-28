// `overview.json`: the overview's pure half (ticket 04); the Worker merges notes and slots into it.
import { overviewPure } from '../../../src/lib/views/overview/pure.server.ts';
import type { ShardModule } from '../types.ts';

export default {
  name: 'overview',
  async build({ pure, json }) {
    return [json('overview.json', overviewPure(pure))];
  },
} satisfies ShardModule;
