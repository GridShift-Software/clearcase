<script lang="ts">
	// The overview's widget slots: a filled slot renders its owner's component with the server data; an unfilled one
	// says which issue owns it. Never a placeholder that looks finished.
	import type { SlotState, WidgetContext } from './overview-slots.ts';
	import { widgets } from './overview-widgets.ts';
	let { slots, ctx }: { slots: SlotState[]; ctx: WidgetContext } = $props();
</script>

{#each slots as s (s.slot.id)}
	{@const W = s.status === 'filled' ? widgets.get(s.slot.id)?.component : undefined}
	<section class="card" aria-labelledby="slot-{s.slot.id}" data-slot={s.slot.id} data-slot-status={s.status === 'filled' && !W ? 'unavailable' : s.status}>
		<h2 id="slot-{s.slot.id}">{s.slot.title}</h2>
		{#if s.status === 'filled' && W}<W data={s.data} {ctx} />
		{:else if s.status === 'error'}<p class="error">{s.message}</p>
		{:else}<p>Not yet available — owned by {s.slot.linear} ({s.slot.owner}).</p>{/if}
	</section>
{/each}
