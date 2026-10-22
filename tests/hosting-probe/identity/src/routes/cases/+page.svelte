<script>
	let { data } = $props();
</script>

<h1>Your cases</h1>
<ul data-cases={data.cases.length}>
	{#each data.cases as c (c.id)}
		<li><a href="/cases/{c.id}">{c.title}</a> ({c.role})</li>
	{/each}
</ul>
