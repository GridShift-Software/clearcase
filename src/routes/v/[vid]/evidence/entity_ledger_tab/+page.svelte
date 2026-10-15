<script lang="ts">
	import { onMount } from 'svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import TableScroll from '$lib/components/TableScroll.svelte';
	let { data } = $props();
	const es = $derived(data.entities ?? []);
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready="entity_ledger_tab" data-hydrated={ready ? '1' : null}>
	<PageHeader heading="Entities" section="Entities" caseName={data.version.titleName} subtitle="{es.length} companies & bodies in the matter" />
	<p class="disclosure" id="identity-status" data-verification="unverified">Roles and notes are imported from processing and have not been verified.</p>
	{#if !data.entities}<p class="warning">This results package has no entities dataset.</p>{/if}
	<div class="card pad0">
		<TableScroll label="Entities"><table class="tbl" id="entities-table">
			<thead><tr><th>Entity</th><th>Role</th><th>Note</th></tr></thead>
			<tbody>{#each es as x, i (i)}<tr><td><b>{x.name}</b></td><td>{x.role}</td><td class="ex">{x.note}</td></tr>{/each}</tbody>
		</table></TableScroll>
	</div>
</main>
