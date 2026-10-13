<script lang="ts">
	import { onMount } from 'svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import TableScroll from '$lib/components/TableScroll.svelte';
	import SourceNote from '$lib/views/litigation/SourceNote.svelte';
	import { EMPTY_QUERY, QUERY_PLACEHOLDER, conflictOptions, matchConflict, matchCountText, noMatchText, type ConflictResult } from '$lib/views/litigation/conflict';
	import { CONFLICT_NOTE, conflictScope } from '$lib/views/litigation/notes';
	let { data } = $props();
	const options = $derived(conflictOptions(data.entities, data.people));
	let query = $state('');
	let result = $state<ConflictResult | null>(null);
	let empty = $state(false);
	// v5 runConflict reads the box when Check is pressed or a party is picked; there is no Enter handler
	// (S-conflict_tab-3, copied). Nothing to search for is said, not silently cleared (D21).
	const run = () => { result = matchConflict(query, data.people, data.entities); empty = result === null; };
	// the blank option clears the box and the result, as in v5
	const pick = (v: string) => { const o = v === '' ? undefined : options[Number(v)]; if (!o) { query = ''; result = null; empty = false; return; } query = o.query; run(); };
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<!-- the data is complete when the server renders the page, so data-ready is set from the start (the pilot checks read
	it from the served HTML); data-hydrated marks when the page's controls work -->
<main id="main" tabindex="-1" data-ready="conflict_tab" data-hydrated={ready ? '1' : null}>
	<PageHeader heading="Conflict Check" section="Conflict Check" caseName={data.version.titleName} subtitle="Screen a party, firm or person against the parties and correspondents in this matter" />
	<div class="card">
		<div class="fields">
			<div class="wide"><label for="confsel">Pick a party / correspondent</label>
				<select id="confsel" disabled={!ready} onchange={(e) => pick(e.currentTarget.value)}>
					<option value="">— choose from the matter —</option>
					{#each options as o, i (i)}<option value={o.value} data-kind={o.kind}>{o.label}</option>{/each}
				</select></div>
			<div class="wide"><label for="confq">…or type a name / firm / email</label><input id="confq" placeholder={QUERY_PLACEHOLDER} bind:value={query} autocomplete="off" disabled={!ready} /></div>
			<div class="go"><button type="button" class="primary" id="conf-check" disabled={!ready} onclick={run}>Check</button></div>
		</div>
		<!-- the check runs in the page only, so a party's name is never sent anywhere; without JavaScript the controls
			stay disabled and say why (D7) -->
		<noscript><p class="note" data-needs-js>The conflict check runs in your browser and needs JavaScript. Turn it on to use this page.</p></noscript>
		<p class="scope" id="conf-scope">{conflictScope(data.people.length, data.entities.length)}</p>
		<div id="confres" aria-live="polite">
			{#if empty}
				<p class="note" data-result="empty">{EMPTY_QUERY}</p>
			{:else if result}
				{#if result.hits.length === 0}
					<div class="badge neutral" data-result="none">{noMatchText(result.query)}</div>
				{:else}
					<div class="badge danger" data-result="matches">{matchCountText(result.hits.length)}</div>
					<TableScroll label="Conflict check matches"><table>
						<thead><tr><th>Kind</th><th>Match</th><th>Detail</th></tr></thead>
						<tbody>{#each result.hits as h, i (i)}<tr><td>{h.kind}</td><td>{h.match}</td><td>{h.detail}</td></tr>{/each}</tbody>
					</table></TableScroll>
				{/if}
			{/if}
		</div>
	</div>
	<SourceNote text={CONFLICT_NOTE} />
</main>

<style>
	.fields { display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; align-items: flex-end; }
	.fields > div { display: flex; flex-direction: column; }
	.fields > .wide { flex: 2 1 16rem; min-width: 0; }
	.fields select { max-width: 100%; min-width: 0; }
	.fields > .go { flex: 0 0 auto; }
	.scope { margin: 0.75rem 0; }
	/* v5's neutral no-match badge, the colours the litigation suite checks (S-conflict_tab-3) */
	.badge.neutral { background: #eef0f3; color: #222; }
</style>
