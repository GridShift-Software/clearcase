<script lang="ts">
	import type { OperatorSubmissionView } from '$lib/submissions/download';
	let { data }: { data: { caseId: string; available: boolean; submissions: OperatorSubmissionView[]; pendingCount: number } } = $props();
</script>

<h1>Finalized submissions of case {data.caseId}</h1>
{#if !data.available}
	<p data-operator-download="unavailable">Operator downloads are not available on this deployment yet.</p>
{:else}
	<section data-operator-download="available" aria-labelledby="submissions-title">
		<h2 id="submissions-title">Submissions</h2>
		{#if data.submissions.length}
			<ol>
				{#each data.submissions as s (s.operationId)}
					<li data-operation={s.operationId}>
						Submission {s.sequence}: {s.files[0].path} ({s.files[0].size} bytes, SHA-256 {s.files[0].sha256}).
						<a href={s.manifestHref} download>Manifest</a>
						(SHA-256 {s.manifestSha256}) · <a href={s.downloadHref} download>Download the PDF</a>
					</li>
				{/each}
			</ol>
		{:else}
			<p>This case has no finalized submission.</p>
		{/if}
		{#if data.pendingCount}<p>{data.pendingCount} upload(s) are not finalized yet and cannot be downloaded.</p>{/if}
		<p>Each download is recorded in the audit log. Nothing here starts, claims or reports processing.</p>
	</section>
{/if}
