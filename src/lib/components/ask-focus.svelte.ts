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
