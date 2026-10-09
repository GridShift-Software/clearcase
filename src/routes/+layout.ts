import { browser } from '$app/environment';
import { useFixedNow } from '$lib/components/clock';
import type { LayoutLoad } from './$types';

// The clock seam's browser side: the server's CLEARCASE_FIXED_NOW setting is in force before any page renders.
export const load: LayoutLoad = ({ data }) => {
	if (browser) useFixedNow(data.fixedNow);
	return data;
};
