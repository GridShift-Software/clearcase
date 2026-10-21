<script>
	let { data, form } = $props();
</script>

<h1 data-case={data.case.id}>{data.case.title}</h1>
<ul>
	{#each data.documents as d (d.id)}
		<li><a href="/cases/{data.case.id}/documents/{d.id}">{d.title}</a></li>
	{/each}
</ul>
<p data-notes={data.notes.length}>Notes: {data.notes.length}</p>
{#if form?.saved}<p data-saved={form.saved}>Saved {form.saved}{form.replayed ? ' (already saved)' : ''}</p>{/if}
{#if form?.error}<p data-error>{form.error}</p>{/if}
