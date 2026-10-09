<script lang="ts">
	// An overview tile filled by a register (GRS-17): the figure and v5's caption.
	let { data }: { data: { value: string; sub: string } } = $props();
</script>

<p class="num">{data.value}</p>
<p><small>{data.sub}</small></p>
