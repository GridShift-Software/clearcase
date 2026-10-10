<script lang="ts">
	import { onMount } from 'svelte';
	import Narrative from '$lib/components/Narrative.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { viewById, viewHref } from '$lib/components/views';
	import SourceNote from '$lib/views/litigation/SourceNote.svelte';
	import { ANALYSIS_NOTE } from '$lib/views/litigation/notes';
	let { data } = $props();
	const vid = $derived(data.version.id);
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready={ready ? 'elements_tab' : null}>
	<PageHeader heading="Cause of Action" section="Cause of Action" caseName={data.version.titleName} subtitle={data.subtitle} />
	<div class="card pad0">
		<div class="wrap"><table id="elements-table">
			<thead><tr>{#each data.columns as c, i (i)}<th>{c}</th>{/each}</tr></thead>
			<tbody>
				{#each data.elements as e, i (i)}
					{@const target = e.target ? viewById(e.target) : null}
					<tr>
						<td><b>{e.element}</b></td>
						<td class="ex"><Narrative text={e.must} resultsVersion={vid} known={data.known} /></td>
						<td class="ex"><Narrative text={e.evidence} resultsVersion={vid} known={data.known} /></td>
						<td data-witness>{e.witness}</td>
						<td>{#if target}<a href={viewHref(vid, target)} data-target={target.id}>open →</a>{:else}<span class="unresolved" data-unknown-view>no such view{e.tab ? `: ${e.tab}` : ''}</span>{/if}</td>
					</tr>
				{:else}
					<tr><td colspan="5"><div class="empty">{data.present ? 'No elements in this results package.' : 'This results package has no cause-of-action analysis.'}</div></td></tr>
				{/each}
			</tbody>
		</table></div>
	</div>
	<SourceNote text={ANALYSIS_NOTE} />
</main>

<style>
	.pad0 { padding: 0; overflow-x: auto; }
	.empty { color: #555; padding: 1rem; text-align: center; }
</style>
