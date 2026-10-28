<script lang="ts">
	import type { OperatorSubmissionView } from '$lib/submissions/download';
	let { data }: { data: { caseId: string; available: boolean; submissions: OperatorSubmissionView[]; pendingCount: number } } = $props();
</script>

<style>
	section, h1 { overflow-wrap: anywhere; }
</style>

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
						{#if s.isNew}<strong data-notification="new">New</strong>{/if}
						{#if s.downloadHref}
							Submission {s.sequence}: {s.files[0].path} ({s.files[0].size} bytes, SHA-256 {s.files[0].sha256}).
							<a href={s.manifestHref} download>Manifest</a>
							(SHA-256 {s.manifestSha256}) · <a href={s.downloadHref} download>Download the PDF</a>
						{:else}
							Submission {s.sequence}: a sealed set of {s.fileCount} PDFs (file list SHA-256 {s.filesSha256}).
							<a href={s.manifestHref} download>Manifest</a> (SHA-256 {s.manifestSha256})
							<details>
								<summary>Download each PDF</summary>
								<ol>
									{#each s.files as f (f.downloadHref)}
										<li><a href={f.downloadHref} download>{f.path}</a> ({f.size} bytes, SHA-256 {f.sha256})</li>
									{/each}
								</ol>
							</details>
						{/if}
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
