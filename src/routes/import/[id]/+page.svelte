<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { plural } from '$lib/components/format';
	import { versionPath } from '$lib/local-case/model';
	import TableScroll from '$lib/components/TableScroll.svelte';
	let { data, form } = $props();
	const r = $derived(data.report);
	const caseName = $derived(r.caseLabel || r.caseId);
	const rv = $derived(r.resultsVersion);
	let busy = $state(false);
</script>

<main id="main" tabindex="-1" data-ready="import:{data.imp.id}" data-verdict={r.verdict}>
	<PageHeader heading="Validation report: import #{data.imp.id}" section="Validation report #{data.imp.id}" {caseName} status={r.verdict} subtitle="Verdict {r.verdict.toUpperCase()} · validated in {r.ms} ms by {r.validatorVersion || 'the importer'}">
		{#snippet actions()}<span class="badge {r.verdict === 'accept' ? 'b-ok' : r.verdict === 'reject' ? 'b-dang' : 'b-warn'}" id="verdict-badge">{r.verdict}</span>{/snippet}
	</PageHeader>
	{#if data.noop}<p class="card" id="noop-msg">This exact package (same results version, byte-identical manifest and files, same case folder) is already stored as import #{data.imp.id} and still verifies. Nothing was written.</p>{/if}
	{#if data.repaired}<p class="card" id="repaired-msg">The stored copy of this results version failed verification; it was rebuilt from this freshly validated package in one transaction.</p>{/if}
	<p class="meta">Package <code class="wrap">{data.imp.packageSource}</code> against case folder <code class="wrap">{data.imp.caseFolder}</code>.</p>
	{#if rv}<p>Case <strong class="wrap">{caseName}</strong> (<code class="wrap">{r.caseId}</code>), results version <code id="results-version" class="wrap">{rv}</code>, manifest sha256 <code>{r.manifestSha256?.slice(0, 16)}…</code>.</p>{/if}

	{#if r.verdict === 'reject'}
		<p class="error" id="verdict-msg" role="alert">Rejected: nothing of this package was stored and the active version is unchanged{data.active ? ` (${data.active})` : ''}. Fix the errors below in the producer and export again.</p>
	{:else if data.pruned}
		<p class="warning" id="verdict-msg">This candidate was removed by the retention policy (it was never activated). Import it again to preview or activate it.</p>
	{:else if data.supersededBy}
		<p class="card" id="verdict-msg">This results version was imported again (repaired) as <a href="/import/{data.supersededBy}">import #{data.supersededBy}</a>.</p>
	{:else if data.vid}
		<section class={r.verdict === 'report' ? 'warning' : 'card'} id="verdict-msg" aria-labelledby="candidate-heading">
			<h2 id="candidate-heading">Candidate</h2>
			<p>Stored as a candidate. It is <strong id="active-state">{data.active === data.vid ? 'ACTIVE' : 'not active'}</strong>{data.active && data.active !== data.vid ? `; the active version is ${data.active}` : ''}.
				Stored copy: <span class={data.check?.ok ? 'ok' : 'unresolved'} id="verify-state">{data.check?.ok ? 'verified' : `FAILED (${data.check?.reason})`}</span>.</p>
			<p class="actions"><a class="btn" href="{versionPath(data.vid)}/overview" id="preview">Preview the candidate</a> <span class="muted">(read-only; previewing never activates it)</span></p>
			{#if data.active !== data.vid}
				<form method="POST" action="?/activate" id="activate-form" onsubmit={() => { busy = true; }}>
					<input type="hidden" name="resultsVersion" value={rv} />
					<input type="hidden" name="manifestSha256" value={r.manifestSha256} />
					<input type="hidden" name="diagnosticsSha256" value={r.diagnosticsSha256} />
					<input type="hidden" name="validatorVersion" value={r.validatorVersion} />
					{#each data.newWarnings as fp (fp)}<input type="hidden" name="fp" value={fp} />{/each}
					{#if data.newWarnings.length}
						<p><label><input type="checkbox" name="ack" id="ack" /> I have reviewed the {plural(data.newWarnings.length, 'new warning')} listed below{data.knownWarnings ? ` (${plural(data.knownWarnings, 'warning')} already accepted for this case are not new)` : ''} and accept them for this results version.</label></p>
					{:else if r.warnings}
						<p>All {plural(r.warnings, 'warning')} were already accepted for this case; no acknowledgement is needed.</p>
					{/if}
					<p><small>Activation re-checks the stored bytes, revalidates every original in the case folder and the acknowledgement, then switches the active version. It takes a few seconds; on any failure nothing changes.</small></p>
					<button id="activate" class="primary" disabled={busy}>Activate this version</button>
				</form>
			{/if}
			{#if form?.message}<p class="error" id="activate-error" role="alert" data-reasons={(form.reasons ?? []).join(' ')}>{form.message}</p>{/if}
		</section>
	{/if}

	{#if data.diff}
		<section class="card" aria-labelledby="diff-heading" id="diff">
			<h2 id="diff-heading">Changes against the active version</h2>
			<p id="diff-summary">Matched by original fingerprint, never by ref: {data.diff.unchanged} unchanged, {data.diff.changedRows.length} with changed rows, {data.diff.renumbered.length} renumbered, {data.diff.added.length} added, {data.diff.removed.length} removed, {data.diff.ambiguous.length} ambiguous fingerprints; {data.diff.unmatched.candidate} candidate documents without an original cannot be matched.</p>
			{#if data.diff.renumbered.length}<p>Renumbered: {data.diff.renumbered.slice(0, 30).map((x) => `${x.from} → ${x.to}`).join(', ')}{data.diff.renumbered.length > 30 ? ', …' : ''}</p>{/if}
			{#if data.diff.ambiguous.length}<p>Ambiguous (several refs share the same bytes; user work is not re-attached automatically): {data.diff.ambiguous.slice(0, 20).map((x) => `${x.base.join('/')} → ${x.candidate.join('/')}`).join('; ')}{data.diff.ambiguous.length > 20 ? '; …' : ''}</p>{/if}
		</section>
	{/if}
	{#if data.notes && data.notes.total}
		<p class="card" id="notes-impact">User work for this case: {plural(data.notes.total, 'note')}; in this candidate {data.notes.here + data.notes.exact} attach to a document, {data.notes.ambiguous} are ambiguous and {data.notes.missing + data.notes.unanchored} would be shown as detached. Activation never changes user work.</p>
	{/if}

	{#if data.textCoverage}
		<section class="card" id="text-coverage" aria-labelledby="text-coverage-heading">
			<h2 id="text-coverage-heading">Source text coverage</h2>
			{#if data.textCoverage.known}
				{#each data.textCoverage.notes as note, i (i)}<p>{note}.</p>{/each}
				<p><em>{data.textCoverage.hint}</em></p>
			{:else}
				<p>This package carries no conversion report, so whether its source export cut document text short is not known.</p>
			{/if}
		</section>
	{/if}

	{#if data.sourceCoverage}
		<section class="card" id="source-coverage" aria-labelledby="source-coverage-heading">
			<h2 id="source-coverage-heading">Source coverage</h2>
			{#if data.sourceCoverage.known}
				<p>What the converter recorded about source data it kept but does not present, or could not map:</p>
				{#each data.sourceCoverage.groups as g (g.code)}
					<h3>{g.code} ({g.total})</h3>
					<ul>{#each g.items as it, i (i)}<li>{#if it.subject}<code>{it.subject}</code>: {/if}{it.message}.</li>{/each}</ul>
					{#if g.hint}<p><em>{g.hint}</em></p>{/if}
				{/each}
			{:else}
				<p>This package carries no conversion report, so what the source export holds beyond the views is not known.</p>
			{/if}
		</section>
	{/if}

	{#if r.app.length}
		<h2>Import checks</h2>
		<ul id="app-diagnostics">{#each r.app as d (d.code + d.message)}<li><strong>{d.code}</strong> ({d.severity}): {d.message}. <em>{d.hint}</em></li>{/each}</ul>
	{/if}

	<h2>Diagnostics</h2>
	<p id="diag-summary">{plural(r.errors, 'error')}, {plural(r.warnings, 'warning')} ({data.newWarnings.length} new for this case){data.groups.length ? '' : '; nothing to report'}.</p>
	<TableScroll label="Diagnostics by code"><table id="diag-counts"><thead><tr><th>Code</th><th>Severity</th><th class="num">Count</th><th class="num">New</th></tr></thead><tbody>
		{#each data.groups as g (g.code)}<tr><td><a href="#code-{g.code}">{g.code}</a></td><td>{g.severity}</td><td class="num">{g.total}</td><td class="num">{g.severity === 'warning' ? g.newCount : ''}</td></tr>{/each}
	</tbody></table></TableScroll>
	{#each data.groups as g (g.code)}
		<details class="diag-code" id="code-{g.code}" data-code={g.code} data-severity={g.severity} open={g.severity === 'error'}>
			<summary><strong>{g.code}</strong> ({g.severity}, {g.cls}): {g.total}{g.total > g.items.length ? `, first ${g.items.length} listed` : ''}</summary>
			<p><em>{g.hint}</em></p>
			<TableScroll label="{g.code} diagnostics"><table><thead><tr><th>Subject</th><th>File</th><th>Where</th><th>Message</th><th></th></tr></thead><tbody>
				{#each g.items as d, i (i)}<tr><td class="wrap">{d.subject}</td><td>{d.file}</td><td class="wrap">{d.pointer}</td><td class="wrap">{d.message}</td><td>{d.isNew ? 'new' : ''}</td></tr>{/each}
			</tbody></table></TableScroll>
		</details>
	{/each}
</main>
