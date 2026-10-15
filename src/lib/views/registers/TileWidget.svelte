<script lang="ts">
	let { data }: { data: { value: string; sub: string } } = $props();
</script>

<p class="num">{data.value}</p>
<p><small>{data.sub}</small></p>
