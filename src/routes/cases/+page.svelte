<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { caseName } from '$lib/components/titles';
	let { data } = $props();
	const STATUS = { active: 'Active', candidate: 'Candidate', recovery: 'Recovery' } as const;
	const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
</script>

<main id="main" tabindex="-1" class="cases-page">
	<PageHeader heading="Cases" section="Cases" subtitle="{plural(data.cases.length, 'case')}.">
		{#snippet actions()}<a class="btn primary" href="/import" id="import-case-link">Import a case</a>{/snippet}
	</PageHeader>
	{#if data.cases.length}
		<ul class="cards" id="case-list">
			{#each data.cases as c (c.caseId)}
				{@const name = caseName(c)}
				<li class="case-card" data-case={c.caseId} data-status={c.status}>
					<div class="case-main">
						<h2 class="wrap">{name}</h2>
						<p class="case-meta">Import {c.version.importId} · stored {c.version.storedAt.slice(0, 10)} · created {c.version.created.slice(0, 10)}</p>
						<p class="case-meta">{c.version.documents === null ? '— documents' : plural(c.version.documents, 'document')} · {plural(c.versions, 'results version')}</p>
					</div>
					<span class="badge {c.status}">{STATUS[c.status]}</span>
					<a class="btn open" href={c.href} aria-label="Open {name}">Open</a>
				</li>
			{/each}
		</ul>
	{:else}
		<div class="empty" id="no-cases">
			<p>No cases yet. Import a case pack to start.</p>
			<p><a class="btn primary" href="/import">Import a case</a></p>
		</div>
	{/if}
</main>
