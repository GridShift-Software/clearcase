// Information Required has no helper file of its own under src/lib/views; its pure half sits beside its shard type.
import { analysisAdditionsEnabled } from '../../analysis/data.server.ts';
import { itemKeys, type InfoItem } from '../../analysis/info-required.server.ts';
import { viewById } from '../../components/views.ts';
import { datasetOf } from '../../local-case/results.server.ts';
import { viewHeading } from '../analysis/headings.ts';
import type { InfoRequiredShard } from './info-required.ts';
import type { PureInput } from './views.ts';

/** Information Required without the saved checks (ticket 04): every item unchecked, keyed as the checks are saved. */
export function infoRequiredPure({ store, vid }: PureInput): InfoRequiredShard {
	const items = datasetOf<InfoItem[]>(store, vid, 'info-required') ?? [];
	const keys = itemKeys(items);
	return { heading: viewHeading(viewById('info_required_tab')!, analysisAdditionsEnabled()), rows: items.map((it, i) => ({ key: keys[i]!, item: it.item, owner: it.owner, status: it.status, done: false })) };
}
