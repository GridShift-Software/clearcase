<script lang="ts">
	import { onMount } from 'svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { QUERY_PLACEHOLDER, conflictOptions, matchConflict, matchCountText, noMatchText, pickedQuery, type ConflictResult } from '$lib/views/litigation/conflict';
	import { conflictScope } from '$lib/views/litigation/notes';
	let { data } = $props();
	const options = $derived(conflictOptions(data.entities, data.people));
	let query = $state('');
	let result = $state<ConflictResult | null>(null);
	// v5 runConflict reads the box when Check is pressed or a party is picked; there is no Enter handler
	// (S-conflict_tab-3, copied)
	const run = () => { result = matchConflict(query, data.people, data.entities); };
	const pick = (v: string) => { query = pickedQuery(v); run(); };
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready={ready ? 'conflict_tab' : null}>
	<PageHeader heading="Conflict Check" section="Conflict Check" caseName={data.version.titleName} subtitle="Screen a party, firm or person against the parties and correspondents in this matter" />
	<div class="card">
		<div class="fields">
			<div class="wide"><label for="confsel">Pick a party / correspondent</label>
				<select id="confsel" onchange={(e) => pick(e.currentTarget.value)}>
					<option value="">— choose from the matter —</option>
					{#each options as o, i (i)}<option value={o.value}>{o.label}</option>{/each}
				</select></div>
			<div class="wide"><label for="confq">…or type a name / firm / email</label><input id="confq" placeholder={QUERY_PLACEHOLDER} bind:value={query} autocomplete="off" /></div>
			<div class="go"><button type="button" class="primary" id="conf-check" onclick={run}>Check</button></div>
		</div>
		<p class="scope" id="conf-scope">{conflictScope(data.people.length, data.entities.length)}</p>
		<div id="confres" aria-live="polite">
			{#if result}
				{#if result.hits.length === 0}
					<div class="badge neutral" data-result="none">{noMatchText(result.query)}</div>
				{:else}
					<div class="badge danger" data-result="matches">{matchCountText(result.hits.length)}</div>
					<table>
						<thead><tr><th>Kind</th><th>Match</th><th>Detail</th></tr></thead>
						<tbody>{#each result.hits as h, i (i)}<tr><td>{h.kind}</td><td>{h.match}</td><td>{h.detail}</td></tr>{/each}</tbody>
					</table>
				{/if}
			{/if}
		</div>
	</div>
</main>

<style>
	.fields { display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; align-items: flex-end; }
	.fields > div { display: flex; flex-direction: column; }
	.fields > .wide { flex: 2 1 16rem; }
	.fields > .go { flex: 0 0 auto; }
	.scope { font-size: 0.9rem; color: #444; margin: 0.75rem 0; }
	.badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 4px; margin-bottom: 0.6rem; }
	.badge.neutral { background: #eef0f3; color: #222; }
	.badge.danger { background: #fde8e8; color: #8a1c1c; }
</style>
