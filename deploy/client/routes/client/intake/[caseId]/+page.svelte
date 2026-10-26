<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { SubmissionView } from '$lib/submissions';
	let { data }: { data: { caseId: string; available: boolean; submissions: SubmissionView[] } } = $props();

	const LABEL: Record<SubmissionView['stage'], string> = {
		received: 'Received, not finalized: the file has not been stored yet',
		'stored-not-finalized': 'Stored, not finalized: send the same file again to finish',
		finalized: 'Finalized: no results yet; ready for the service team to process manually',
	};
	let file: File | null = $state(null);
	let status = $state('');
	let busy = $state(false);
	// One upload id per chosen file, kept across a failed attempt so a retry finishes the same submission.
	let pending: { file: File; operationId: string } | null = null;

	const base = () => `/client/intake/${encodeURIComponent(data.caseId)}/submissions`;
	async function sha256(bytes: ArrayBuffer) {
		return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) => n.toString(16).padStart(2, '0')).join('');
	}
	async function send() {
		if (!file || busy) return;
		busy = true;
		status = 'Checking the file…';
		// The picker stays live while the bytes are read: take the file, its name and its upload id before the first await,
		// so the declaration, the bytes and a retry all describe this file. A later pick is a new send with a new upload id.
		const chosen = file, { name } = chosen;
		try {
			if (pending?.file !== chosen) pending = { file: chosen, operationId: crypto.randomUUID() };
			const attempt = pending, { operationId } = attempt;
			const bytes = await chosen.arrayBuffer();
			const meta = { operationId, path: name, size: bytes.byteLength, sha256: await sha256(bytes), mediaType: 'application/pdf' };
			const d = await fetch(base(), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(meta) });
			if (!d.ok) { status = ((await d.json()) as { message?: string }).message ?? `Refused (${d.status}).`; return; }
			status = 'Sending the file…';
			const u = await fetch(`${base()}/${operationId}`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/pdf' }, body: bytes });
			const body = (await u.json()) as { message?: string; stage?: string };
			if (!u.ok) { status = body.message ?? `Refused (${u.status}).`; return; }
			if (pending === attempt) pending = null;
			status = 'Finalized. No results yet.';
			await invalidateAll();
		} catch {
			status = 'The upload did not finish. Try again: the same file keeps the same upload.';
		} finally {
			busy = false;
		}
	}
</script>

<h1>Supply a file for case {data.caseId}</h1>
{#if !data.available}
	<p data-intake-state="unavailable">File intake is not available on this deployment yet.</p>
{:else}
	<form data-intake-state="available" onsubmit={(e) => { e.preventDefault(); void send(); }}>
		<label>One PDF file <input type="file" accept="application/pdf,.pdf" onchange={(e) => { file = (e.currentTarget as HTMLInputElement).files?.[0] ?? null; }} /></label>
		<button type="submit" disabled={!file || busy}>Send</button>
		<p role="status">{status}</p>
	</form>
	<section aria-labelledby="submissions-title">
		<h2 id="submissions-title">Submissions</h2>
		{#if data.submissions.length}
			<ol>
				{#each data.submissions as s (s.operationId)}
					<li data-stage={s.stage}>
						{s.path} ({s.size} bytes): {LABEL[s.stage]}
						{#if s.manifest}<span> (submission {s.manifest.sequence})</span>{/if}
					</li>
				{/each}
			</ol>
		{:else}
			<p>No files have been supplied for this case.</p>
		{/if}
	</section>
{/if}
