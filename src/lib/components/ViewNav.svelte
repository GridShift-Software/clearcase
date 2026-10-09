<script lang="ts">
	// The 42 navigation entries from the registry, in v5 group order. Every entry is a real link with a real history
	// entry; unavailable entries lead to an explicit "not yet available" page. Labels are the registry task names.
	import { blockedBy, grouped, viewHref } from './views.ts';
	let { resultsVersion, current = null }: { resultsVersion: string; current?: string | null } = $props();
	const groups = grouped();
</script>

<nav class="views" aria-label="Case views">
	{#each groups as g (g.group)}
		<section aria-labelledby="nav-group-{g.group.replace(/\W+/g, '-')}">
			<h2 id="nav-group-{g.group.replace(/\W+/g, '-')}">{g.group}</h2>
			<ul>
				{#each g.views as v (v.id)}
					{@const owner = blockedBy(v)}
					<li>
						<a href={viewHref(resultsVersion, v)} id="nav-{v.id}" data-view={v.id} data-status={v.status} aria-current={current === v.id ? 'page' : undefined} class:unavailable={!!owner}>
							{v.label}{#if owner}<span class="visually-hidden"> (not yet available)</span>{/if}
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{/each}
</nav>
