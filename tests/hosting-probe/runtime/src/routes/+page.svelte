<script>
	let { data, form } = $props();
</script>

<h1>ClearCase runtime probe</h1>
<p id="count">D1 notes: {data.notes.length}</p>
<ul>
	{#each data.notes as note (note.id)}
		<li>{note.id}: {note.body}</li>
	{/each}
</ul>
<p id="latest">R2 latest: {data.latest ?? 'empty'}</p>
<form method="POST" action="?/save">
	<label>Id <input name="id" /></label>
	<label>Body <input name="body" /></label>
	<button>Save</button>
</form>
{#if form?.error}<p id="error" role="alert">{form.error}</p>{/if}
{#if form?.saved}<p id="saved">Saved {form.saved}; R2 read back: {form.readBack}</p>{/if}
