<script lang="ts">
	// A route page whose `data` and `form` the test replaces, as SvelteKit does when an action answers or a navigation
	// reloads the data: the page instance stays and only its props change.
	import { untrack, type Component } from 'svelte';
	let { Page, data: firstData, form: firstForm = null }: { Page: Component<any>; data: unknown; form?: unknown } = $props();
	let data = $state.raw(untrack(() => firstData));
	let form = $state.raw(untrack(() => firstForm));
	export function answer(next: { data?: unknown; form?: unknown }) {
		if (next.data !== undefined) data = next.data;
		if (next.form !== undefined) form = next.form;
	}
</script>

<Page {data} {form} />
