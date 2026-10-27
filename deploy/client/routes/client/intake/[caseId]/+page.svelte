<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { signInHref } from '$lib/auth/sign-in-link';
	import { reloadForSignIn } from '$lib/views/hosted/reauth';
	import type { SubmissionView } from '$lib/submissions';
	// `canUpload` is the server's advisory answer for this reader; absent means unknown, and the audited send decides.
	let { data }: { data: { caseId: string; available: boolean; canUpload?: boolean; submissions: SubmissionView[] } } = $props();

	const LABEL: Record<SubmissionView['stage'], string> = {
		received: 'Received, not finalized: the file has not been stored yet',
		'stored-not-finalized': 'Stored, not finalized: send the same file again to finish',
		finalized: 'Finalized: no results yet; ready for the service team to process manually',
	};
	let file: File | null = $state(null);
	let status = $state('');
	let busy = $state(false);
	// A send refused as signed out keeps the person on the page with a way back in that returns here.
	let signInNeeded = $state(false);
	// One upload id per chosen file, kept across a failed attempt so a retry finishes the same submission.
	let pending: { file: File; operationId: string } | null = null;

	const base = () => `/client/intake/${encodeURIComponent(data.caseId)}/submissions`;
	async function sha256(bytes: ArrayBuffer) {
		return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) => n.toString(16).padStart(2, '0')).join('');
	}
	async function send() {
		if (!file || busy) return;
		busy = true;
		signInNeeded = false;
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
			if (reloadForSignIn(d)) { status = 'Your session ended while the page was idle. The page is reloading to sign you in again; send the file again once it has loaded.'; return; }
			if (!d.ok) { signInNeeded = d.status === 401; status = ((await d.json()) as { message?: string }).message ?? `Refused (${d.status}).`; return; }
			status = 'Sending the file…';
			const u = await fetch(`${base()}/${operationId}`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/pdf' }, body: bytes });
			const body = (await u.json()) as { message?: string; stage?: string };
			if (reloadForSignIn(u)) { status = 'Your session ended while the page was idle. The page is reloading to sign you in again; send the file again once it has loaded.'; return; }
			if (!u.ok) { signInNeeded = u.status === 401; status = body.message ?? `Refused (${u.status}).`; return; }
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
{#snippet submissions()}
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
{/snippet}
{#if !data.available}
	<p data-intake-state="unavailable">File intake is not available on this deployment yet.</p>
{:else if data.canUpload === false}
	<p data-intake-state="no-upload-grant">Your account is not set up to supply files for this case. You can see the files already supplied below. To supply a file, ask the service team to enable uploads for your account.</p>
	{@render submissions()}
{:else if data.canUpload !== true}
	<p data-intake-state="upload-unknown">We could not check whether your account can supply files for this case right now. Reload the page to try again. You can see the files already supplied below.</p>
	{@render submissions()}
{:else}
	<form data-intake-state="available" onsubmit={(e) => { e.preventDefault(); void send(); }}>
		<label>One PDF file <input type="file" accept="application/pdf,.pdf" onchange={(e) => { file = (e.currentTarget as HTMLInputElement).files?.[0] ?? null; }} /></label>
		<button type="submit" disabled={!file || busy}>Send</button>
		<p role="status">{status}</p>
		{#if signInNeeded}<p><a data-intake-sign-in href={signInHref(`/client/intake/${encodeURIComponent(data.caseId)}`)} data-sveltekit-reload>Sign in again</a></p>{/if}
	</form>
	{@render submissions()}
{/if}
