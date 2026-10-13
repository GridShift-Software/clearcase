// Focus for a page's leave question (GRS-59, as GRS-17 does on the registers): the question takes focus on its safe
// answer when it opens, and again after a cancelled Back, whose popstate lets the layout move focus to the heading;
// `back()` gives focus to what had it when the question opened, so Keep or Stay never leaves it on <body>.
import { onMount, tick } from 'svelte';

export function askFocus(open: () => boolean, askId: string, keepId: string) {
	let opener: HTMLElement | null = null;
	$effect(() => {
		if (!open()) return;
		const a = document.activeElement;
		opener = a instanceof HTMLElement && a !== document.body && !a.closest(`#${askId}`) ? a : null;
		void tick().then(() => document.getElementById(keepId)?.focus());
	});
	onMount(() => {
		const h = () => setTimeout(() => { if (open()) document.getElementById(keepId)?.focus(); });
		addEventListener('popstate', h);
		return () => removeEventListener('popstate', h);
	});
	return { back: () => void tick().then(() => (opener?.isConnected ? opener : document.getElementById('main'))?.focus()) };
}
