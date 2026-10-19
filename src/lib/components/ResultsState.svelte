<script lang="ts">
	import type { ResultsStatus } from '$lib/server/runtime/contracts';
	// The results area of a case with no results to show: a safe status, the reason and the next action, never
	// placeholder or stale results. The case's originals and the user's own work sit beside it and do not depend on it.
	let { status }: { status: ResultsStatus } = $props();
	const text = $derived(
		status.kind === 'pending'
			? { title: 'Results are not published yet', reason: 'This case has no published results version. Processing may still be under way.', next: 'You can open the case originals and keep your own notes now. Results appear here once they are published.' }
			: status.kind === 'withdrawn'
				? { title: 'Results were withdrawn', reason: 'The results version published for this case has been withdrawn.', next: 'The case originals and your own work are unaffected. Results appear here when a new version is published.' }
				: { title: 'Results are unavailable', reason: status.reason, next: 'Try again shortly. The case originals and your own work do not depend on results.' },
	);
</script>

<section class="results-state" data-results-state={status.kind} role="status" aria-labelledby="results-state-title">
	<h2 id="results-state-title">{text.title}</h2>
	<p data-results-reason>{text.reason}</p>
	<p data-results-next>{text.next}</p>
</section>

<style>
	.results-state { border: 1px solid #ccc; border-radius: 4px; padding: 0.75rem 1rem; margin: 1rem 0; }
	h2 { margin: 0 0 0.5rem; font-size: 1.1rem; }
	p { margin: 0.25rem 0; }
</style>
