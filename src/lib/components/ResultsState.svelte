<script lang="ts">
	import type { ResultsStatus } from '$lib/server/runtime/contracts';
	// The results area of a case with no results to show: a safe status, the reason and the next action, never
	// placeholder or stale results. The case's originals and the user's own work sit beside it and do not depend on it.
	let { status }: { status: ResultsStatus } = $props();
	const text = $derived(
		status.kind === 'pending'
			? { title: 'Results are not published yet', reason: 'This case has no published results version. Processing may still be under way.', next: 'You can open the case originals now. Your own work does not depend on results. Results appear here once they are published.' }
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
	.results-state { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-card); box-shadow: var(--shadow-sm); padding: 20px; margin: 16px 0; }
	h2 { margin: 0 0 8px; font-size: 14px; line-height: 1.5; }
	p { margin: 4px 0; color: var(--ink-2); }
</style>
