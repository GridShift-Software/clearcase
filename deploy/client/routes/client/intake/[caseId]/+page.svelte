<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { signInHref } from '$lib/auth/sign-in-link';
	import { reloadForSignIn } from '$lib/views/hosted/reauth';
	import type { SetView, SubmissionView } from '$lib/submissions';
	import { fileSetDigest } from '$lib/submissions/file-set';
	// `canUpload` is the server's advisory answer for this reader; absent means unknown, and the audited send decides.
	let { data }: { data: { caseId: string; available: boolean; canUpload?: boolean; submissions: SubmissionView[]; sets?: SetView[] } } = $props();

	const LABEL: Record<SubmissionView['stage'], string> = {
		received: 'Received, not finalized: the file has not been stored yet',
		'stored-not-finalized': 'Stored, not finalized: send the same file again to finish',
		finalized: 'Finalized: no results yet; ready for the service team to process manually',
	};
	const SET_LABEL: Record<SetView['state'], string> = {
		open: 'Open: not every file has been stored and sealed yet; choose the same files again to finish',
		sealing: 'Sealing: choose the same files again to finish',
		sealed: 'Sealed: no results yet; ready for the service team to process manually',
	};
	let file: File | null = $state(null);
	let status = $state('');
	let busy = $state(false);
	// A send refused as signed out keeps the person on the page with a way back in that returns here.
	let signInNeeded = $state(false);
	// One upload id per chosen file, kept across a failed attempt so a retry finishes the same submission.
	let pending: { file: File; operationId: string } | null = null;

	// Several files are one submission: a set. Each file is declared and stored on its own, then the set is sealed.
	type Row = { file: File; path: string; size: number; sha256: string; operationId: string; stage: 'waiting' | 'sending' | 'stored' | 'failed'; error: string };
	let rows: Row[] = $state([]);
	let set: SetView | null = $state(null);
	let failed = $derived(rows.filter((r) => r.stage === 'failed').length);
	const UPLOADS_AT_ONCE = 3;
	// Each pick is a new selection. A set's send belongs to the selection it started with and stops writing to the page once
	// another pick replaces it, so an answer that arrives late never shows its set state against files it did not send. The
	// picker is disabled while a set is sent. One file keeps its own behaviour: its send finishes and reports for that file.
	let selection = 0;

	const base = () => `/client/intake/${encodeURIComponent(data.caseId)}/submissions`;
	const sets = () => `/client/intake/${encodeURIComponent(data.caseId)}/sets`;
	async function sha256(bytes: ArrayBuffer | Uint8Array) {
		return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), (n) => n.toString(16).padStart(2, '0')).join('');
	}
	const message = async (r: Response) => ((await r.json().catch(() => ({}))) as { message?: string }).message ?? `Refused (${r.status}).`;
	const post = (url: string, body: unknown) => fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

	function choose(picked: File[]) {
		selection++;
		file = picked.length === 1 ? picked[0]! : null;
		set = null;
		status = '';
		rows = picked.length > 1 ? picked.map((f) => ({ file: f, path: f.name.normalize('NFC'), size: f.size, sha256: '', operationId: '', stage: 'waiting', error: '' })) : [];
	}

	async function send() {
		if (!file || busy) return;
		busy = true;
		signInNeeded = false;
		status = 'Checking the file…';
		// The picker stays live while the bytes are read: take the file, its name and its upload id before the first await,
		// so the declaration, the bytes and a retry all describe this file. A later pick is a new send with a new upload id.
		const chosen = file, { name } = chosen;
		// The send keeps going after a new pick, so every outcome names the file it sent, never the one now in the picker.
		const about = (text: string) => `${name}: ${text}`;
		try {
			if (pending?.file !== chosen) pending = { file: chosen, operationId: crypto.randomUUID() };
			const attempt = pending, { operationId } = attempt;
			const bytes = await chosen.arrayBuffer();
			const meta = { operationId, path: name, size: bytes.byteLength, sha256: await sha256(bytes), mediaType: 'application/pdf' };
			const d = await fetch(base(), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(meta) });
			if (reloadForSignIn(d)) { status = 'Your session ended while the page was idle. The page is reloading to sign you in again; send the file again once it has loaded.'; return; }
			if (!d.ok) { signInNeeded = d.status === 401; status = about(((await d.json()) as { message?: string }).message ?? `Refused (${d.status}).`); return; }
			status = `Sending ${name}…`;
			const u = await fetch(`${base()}/${operationId}`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/pdf' }, body: bytes });
			const body = (await u.json()) as { message?: string; stage?: string };
			if (reloadForSignIn(u)) { status = 'Your session ended while the page was idle. The page is reloading to sign you in again; send the file again once it has loaded.'; return; }
			if (!u.ok) { signInNeeded = u.status === 401; status = about(body.message ?? `Refused (${u.status}).`); return; }
			if (pending === attempt) pending = null;
			status = `Finalized ${name}. No results yet.`;
			await invalidateAll();
		} catch {
			status = about('The upload did not finish. Try again: the same file keeps the same upload.');
		} finally {
			busy = false;
		}
	}

	// The set id and each file's upload id come from the file list itself, so choosing the same files again (after a failure,
	// a reload or a lost connection) resumes the same set: stored files are not sent again.
	async function sendSet() {
		if (rows.length < 2 || busy) return;
		busy = true;
		signInNeeded = false;
		const chosen = rows, mine = selection, live = () => mine === selection;
		try {
			status = 'Checking the files…';
			for (const r of chosen) if (!r.sha256) { const bytes = await r.file.arrayBuffer(); r.size = bytes.byteLength; r.sha256 = await sha256(bytes); }
			const digest = await fileSetDigest(chosen);
			const setId = `set-${(await sha256(new TextEncoder().encode(`${data.caseId}\n${digest}`))).slice(0, 40)}`;
			for (const r of chosen) if (!r.operationId) r.operationId = `fs-${(await sha256(new TextEncoder().encode(`${setId}\n${r.path}`))).slice(0, 40)}`;
			const opened = await post(sets(), { setId, fileCount: chosen.length, totalBytes: chosen.reduce((n, r) => n + r.size, 0) });
			if (!live()) return;
			if (reloadForSignIn(opened)) { status = 'Your session ended while the page was idle. The page is reloading to sign you in again; choose the same files again once it has loaded.'; return; }
			if (!opened.ok) { const text = await message(opened); if (live()) { signInNeeded = opened.status === 401; status = text; } return; }
			const first = ((await opened.json()) as { set: SetView }).set;
			if (!live()) return;
			set = first;
			if (first.state === 'open' && first.stored > 0) await learnStored(setId, chosen);
			if (!live()) return;
			if (first.state === 'open') {
				status = 'Sending the files…';
				const queue = chosen.filter((r) => r.stage !== 'stored');
				await Promise.all(Array.from({ length: Math.min(UPLOADS_AT_ONCE, queue.length) }, async () => { for (let r = queue.shift(); r && live(); r = queue.shift()) await sendOne(setId, r); }));
				if (!live()) return;
				if (chosen.some((r) => r.stage === 'failed')) { status = 'Some files did not finish. Retry sends only those; the stored files are kept.'; return; }
			}
			await seal(setId, digest, live);
		} catch {
			if (live()) status = 'The upload did not finish. Retry: stored files are kept and not sent again.';
		} finally {
			busy = false;
		}
	}
	async function learnStored(setId: string, chosen: Row[]) {
		const byOperation = new Map(chosen.map((r) => [r.operationId, r]));
		let after: string | null = null;
		for (;;) {
			const r = await fetch(`${sets()}/${setId}${after === null ? '' : `?after=${encodeURIComponent(after)}`}`, { credentials: 'same-origin' });
			if (!r.ok) return;
			const page = (await r.json()) as { files: { operationId: string; stage: string }[]; next: string | null };
			for (const f of page.files) { const row = byOperation.get(f.operationId); if (row && f.stage !== 'received') row.stage = 'stored'; }
			if (page.next === null) return;
			after = page.next;
		}
	}
	async function sendOne(setId: string, r: Row) {
		r.stage = 'sending';
		r.error = '';
		try {
			const d = await post(`${sets()}/${setId}/files`, { operationId: r.operationId, path: r.path, size: r.size, sha256: r.sha256, mediaType: 'application/pdf' });
			if (!d.ok) { r.stage = 'failed'; r.error = await message(d); return; }
			const u = await fetch(`${sets()}/${setId}/files/${r.operationId}`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/pdf' }, body: await r.file.arrayBuffer() });
			if (!u.ok) { r.stage = 'failed'; r.error = await message(u); return; }
			r.stage = 'stored';
		} catch {
			r.stage = 'failed';
			r.error = 'The upload did not finish.';
		}
	}
	async function seal(setId: string, digest: string, live: () => boolean) {
		for (;;) {
			status = set && set.state === 'sealing' ? `Sealing: ${set.finalized} of ${set.fileCount} files finalized…` : 'Sealing the set…';
			const r = await post(`${sets()}/${setId}/seal`, { filesSha256: digest });
			if (!live()) return;
			if (!r.ok) { const text = await message(r); if (live()) { signInNeeded = r.status === 401; status = text; } return; }
			const next = ((await r.json()) as { set: SetView }).set;
			if (!live()) return;
			set = next;
			if (r.status !== 202) break;
		}
		status = 'Sealed. No results yet.';
		await invalidateAll();
	}
</script>

<h1>Supply files for case {data.caseId}</h1>
{#snippet submissions()}
	<section aria-labelledby="submissions-title">
		<h2 id="submissions-title">Submissions</h2>
		{#if data.submissions.length || data.sets?.length}
			<ol>
				{#each data.submissions as s (s.operationId)}
					<li data-stage={s.stage}>
						{s.path} ({s.size} bytes): {LABEL[s.stage]}
						{#if s.manifest}<span> (submission {s.manifest.sequence})</span>{/if}
					</li>
				{/each}
				{#each data.sets ?? [] as s (s.setId)}
					<li data-set={s.setId} data-stage={s.state}>
						A set of {s.fileCount} files ({s.totalBytes} bytes): {SET_LABEL[s.state]}
						{#if s.revision}<span> (submission {s.revision.sequence})</span>{/if}
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
	<form data-intake-state="available" onsubmit={(e) => { e.preventDefault(); void (rows.length > 1 ? sendSet() : send()); }}>
		<label>PDF files (one, or several sent as one submission) <input type="file" multiple accept="application/pdf,.pdf" disabled={busy && rows.length > 1} onchange={(e) => choose([...((e.currentTarget as HTMLInputElement).files ?? [])])} /></label>
		<button type="submit" disabled={!(file || rows.length > 1) || busy}>Send</button>
		<p role="status">{status}</p>
		{#if signInNeeded}<p><a data-intake-sign-in href={signInHref(`/client/intake/${encodeURIComponent(data.caseId)}`)} data-sveltekit-reload>Sign in again</a></p>{/if}
	</form>
	{#if rows.length > 1}
		<section aria-labelledby="set-title">
			<h2 id="set-title">{rows.length} files, sent as one submission</h2>
			{#if set}
				<p data-set-state={set.state}>
					{#if set.state === 'sealed' && set.revision}Sealed: {set.fileCount} files as submission {set.revision.sequence}. The set cannot change; a new set is a new submission. No results yet.
					{:else if set.state === 'sealing'}Sealing: {set.finalized} of {set.fileCount} files finalized.
					{:else}Open: {set.stored} of {set.fileCount} files stored. The set is sealed once every file is stored.{/if}
				</p>
			{/if}
			<ol>
				{#each rows as r (r.path)}
					<li data-file={r.path} data-file-stage={r.stage}>
						{r.path} ({r.size} bytes): {r.stage === 'stored' ? 'stored' : r.stage === 'sending' ? 'sending…' : r.stage === 'failed' ? `failed: ${r.error}` : 'waiting'}
					</li>
				{/each}
			</ol>
			{#if failed && !busy}<button type="button" data-retry onclick={() => void sendSet()}>Retry the {failed} failed file{failed === 1 ? '' : 's'}</button>{/if}
		</section>
	{/if}
	{@render submissions()}
{/if}
