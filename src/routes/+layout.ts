import { browser } from '$app/env';
import { useFixedNow } from '$lib/components/clock';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = ({ data }) => {
	if (browser) useFixedNow(data.fixedNow);
	return data;
};
