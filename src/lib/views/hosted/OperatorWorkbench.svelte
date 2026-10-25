<script module lang="ts">
  import type { LinkedCandidate } from '../../results-review/native/ports.ts';
  import type { OperatorSubmissionView } from '../../submissions/download/controller.ts';
  import type { ReadinessView } from '../../publication/hosted/readiness.ts';
  import type { PublicationState } from '../../publication/hosted/ports.ts';
  import { canonicalJson } from '../../case-package/canonical.ts';
  import { candidateIdOf, linkIdOf, sha256Text } from '../../results-review/native/digest.ts';

  type ImportBody = { operationId: string; submissionRevisionId: string; files: Record<string, string> };
  type CorrectionBody = { operationId: string; reason: string; replacements: { key: string; data: unknown }[] };
  type ImportExpectation = { clientId: string; caseId: string; submissionRevisionId: string; submissionManifestSha256: string;
    resultsVersion: string; manifestSha256: string; packageInputRevisionId: string };
  export type Pending = { path: string } & (
    | { kind: 'import'; body: ImportBody; expected: ImportExpectation }
    | { kind: 'correction'; body: CorrectionBody; expected: LinkedCandidate }
    | { kind: 'signoff'; body: ReturnType<typeof signoffPayload> }
    | { kind: 'publish'; body: ReturnType<typeof publishPayload>; expected: { resultsVersion: string } }
  );
  const SHA = /^[0-9a-f]{64}$/, RV = /^sha256:[0-9a-f]{64}$/, PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1000;
  function requireResponse(ok: unknown): asserts ok { if (!ok) throw new Error('Unconfirmed controller response.'); }
  function object(v: unknown, keys: string[]): Record<string, unknown> {
    requireResponse(v !== null && typeof v === 'object' && !Array.isArray(v));
    requireResponse(Object.keys(v).sort().join() === [...keys].sort().join());
    return v as Record<string, unknown>;
  }
  function list(v: unknown): unknown[] { requireResponse(Array.isArray(v)); return v; }
  function digestSize(v: unknown) {
    const x = object(v, ['sha256', 'size']);
    requireResponse(typeof x.sha256 === 'string' && SHA.test(x.sha256) && Number.isSafeInteger(x.size) && Number(x.size) >= 0);
  }
  function operator(v: unknown, staff = false) {
    const x = object(v, staff ? ['issuer', 'subject', 'kind'] : ['issuer', 'subject']);
    requireResponse(text(x.issuer) && text(x.subject) && (!staff || x.kind === 'staff'));
  }
  function timestamp(v: unknown) { requireResponse(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v))); }
  function strings(v: unknown) { requireResponse(list(v).every(text)); }
  // Validate the entire linked-success DTO, not merely the existence of a candidate property.
  function linkedResponse(v: unknown): LinkedCandidate {
    const out = object(v, ['kind', 'repeated', 'candidate']);
    requireResponse(out.kind === 'linked' && typeof out.repeated === 'boolean');
    const c = object(out.candidate, ['candidateId', 'origin', 'parentCandidateId', 'current', 'supersededBy', 'link', 'correction']);
    requireResponse(text(c.candidateId) && PART.test(c.candidateId) && ['import', 'correction'].includes(String(c.origin))
      && typeof c.current === 'boolean' && (c.supersededBy === null || text(c.supersededBy))
      && (c.parentCandidateId === null || text(c.parentCandidateId)) && (!c.current || c.supersededBy === null));
    const l = object(c.link, ['format', 'linkId', 'clientId', 'caseId', 'submissionRevisionId', 'submissionManifestSha256', 'candidate', 'coverage', 'operator', 'linkedAt', 'attribution', 'state']);
    requireResponse(l.format === 'clearcase.candidate-import-link/1' && l.state === 'private-candidate-linked'
      && l.attribution === 'manual-operator-link-not-processing-proof' && text(l.linkId)
      && text(l.clientId) && text(l.caseId) && text(l.submissionRevisionId)
      && typeof l.submissionManifestSha256 === 'string' && SHA.test(l.submissionManifestSha256));
    const pin = object(l.candidate, ['clientId', 'caseId', 'candidateId', 'resultsVersion', 'manifestSha256', 'packageInputRevisionId']);
    requireResponse(pin.clientId === l.clientId && pin.caseId === l.caseId && pin.candidateId === c.candidateId
      && typeof pin.resultsVersion === 'string' && RV.test(pin.resultsVersion)
      && typeof pin.manifestSha256 === 'string' && SHA.test(pin.manifestSha256)
      && typeof pin.packageInputRevisionId === 'string' && RV.test(pin.packageInputRevisionId));
    operator(l.operator, true); timestamp(l.linkedAt);
    const coverage = object(l.coverage, ['policy', 'mappedOriginals', 'unavailableOriginals']);
    requireResponse(coverage.policy === 'exact-required-file-set/1');
    for (const value of list(coverage.mappedOriginals)) {
      const warning = (value as { pathMatch?: unknown } | null)?.pathMatch === 'case-nfc-unique';
      const m = object(value, ['packageRefs', 'packagePath', 'storedPath', 'submissionAssetId', 'sha256', 'size', 'pathMatch', ...(warning ? ['preservedWarning'] : [])]);
      strings(m.packageRefs); requireResponse(list(m.packageRefs).length > 0 && text(m.packagePath) && text(m.storedPath) && text(m.submissionAssetId));
      digestSize({ sha256: m.sha256, size: m.size });
      requireResponse(m.pathMatch === 'literal' || warning);
      if (warning) {
        const w = object(m.preservedWarning, ['code', 'fingerprints']);
        requireResponse(w.code === 'ORIG_CASE_MISMATCH' && list(w.fingerprints).length > 0
          && list(w.fingerprints).every((f) => typeof f === 'string' && /^[0-9a-f]{32}$/.test(f)));
      }
    }
    for (const value of list(coverage.unavailableOriginals)) {
      const missing = (value as { kind?: unknown } | null)?.kind === 'missing';
      const u = object(value, ['kind', 'ref', missing ? 'path' : 'parentRef']);
      requireResponse((u.kind === 'missing' || u.kind === 'embedded') && text(u.ref) && text(missing ? u.path : u.parentRef));
    }
    if (c.origin === 'import') requireResponse(c.parentCandidateId === null && c.correction === null);
    else {
      requireResponse(text(c.parentCandidateId) && c.parentCandidateId !== c.candidateId);
      const correction = object(c.correction, ['reason', 'operator', 'at', 'changes']);
      requireResponse(text(correction.reason)); operator(correction.operator); timestamp(correction.at);
      requireResponse(correction.at === l.linkedAt);
      requireResponse(canonicalJson(correction.operator) === canonicalJson({ issuer: (l.operator as Record<string, unknown>).issuer, subject: (l.operator as Record<string, unknown>).subject }));
      const changes = list(correction.changes); requireResponse(changes.length > 0 && changes.length <= 8);
      const paths = new Set();
      for (const value of changes) {
        const change = object(value, ['path', 'before', 'after']);
        requireResponse(text(change.path) && /^datasets\/[a-z][a-z0-9-]*\.json$/.test(change.path) && !paths.has(change.path));
        paths.add(change.path);
        if (change.before !== null) digestSize(change.before);
        digestSize(change.after);
      }
    }
    return out.candidate as LinkedCandidate;
  }
  export async function assertOperationSuccess(request: Pending, status: number, value: unknown): Promise<void> {
    requireResponse(status === 200 || status === 201);
    if (request.kind === 'signoff') {
      const v = object(value, ['signoffId', 'state', 'resultsVersion', 'selfApproval']);
      requireResponse(v.signoffId === `so-${request.body.operationId}` && v.state === 'signed-off'
        && v.resultsVersion === request.body.identity.resultsVersion && v.selfApproval === request.body.selfApproval);
    } else if (request.kind === 'publish') {
      const v = object(value, ['operationId', 'publication']), p = object(v.publication, ['kind', 'resultsVersion']);
      requireResponse(status === 200 && v.operationId === request.body.operationId && p.kind === 'published'
        && p.resultsVersion === request.expected.resultsVersion);
    } else {
      const c = linkedResponse(value), l = c.link, pin = l.candidate;
      requireResponse(status === ((value as { repeated: boolean }).repeated ? 200 : 201));
      requireResponse(c.candidateId === await candidateIdOf(pin)
        && l.linkId === await linkIdOf({ candidateId: c.candidateId, submissionRevisionId: l.submissionRevisionId, submissionManifestSha256: l.submissionManifestSha256 }));
      if (request.kind === 'import') {
        const e = request.expected;
        requireResponse(c.origin === 'import' && l.clientId === e.clientId && l.caseId === e.caseId
          && l.submissionRevisionId === request.body.submissionRevisionId && l.submissionRevisionId === e.submissionRevisionId
          && l.submissionManifestSha256 === e.submissionManifestSha256 && pin.resultsVersion === e.resultsVersion
          && pin.manifestSha256 === e.manifestSha256 && pin.packageInputRevisionId === e.packageInputRevisionId);
      } else {
        const parent = request.expected, old = parent.link;
        requireResponse(c.origin === 'correction' && c.parentCandidateId === parent.candidateId
          && l.clientId === old.clientId && l.caseId === old.caseId && l.submissionRevisionId === old.submissionRevisionId
          && l.submissionManifestSha256 === old.submissionManifestSha256 && pin.packageInputRevisionId === old.candidate.packageInputRevisionId
          && pin.resultsVersion !== old.candidate.resultsVersion && pin.manifestSha256 !== old.candidate.manifestSha256
          && c.correction?.reason === request.body.reason
          && c.correction.changes.every((x) => request.body.replacements.some((r) => x.path === `datasets/${r.key}.json`)));
      }
    }
  }

  export interface WorkbenchData {
    caseId: string;
    submissions: OperatorSubmissionView[];
    candidates: LinkedCandidate[];
    submissionFailure: null | { status: number; code: string; message: string };
    candidateFailure: null | { status: number; code: string; message: string };
  }
  // Browser-side consistency checks are UX only. The existing server controllers retain all authority/validation.
  export function assertReadiness(v: ReadinessView, caseId: string, c: LinkedCandidate, s: OperatorSubmissionView): void {
    const i = v?.identity, pin = c.link.candidate;
    if (!i || v.caseId !== caseId || !c.current || c.candidateId !== i.candidateId || pin.candidateId !== i.candidateId
      || c.link.caseId !== caseId || pin.caseId !== caseId || s.caseId !== caseId
      || i.linkId !== c.link.linkId || i.resultsVersion !== pin.resultsVersion || i.manifestSha256 !== pin.manifestSha256
      || i.packageInputRevisionId !== pin.packageInputRevisionId || i.submissionRevisionId !== s.revisionId
      || i.submissionRevisionId !== c.link.submissionRevisionId || i.submissionManifestSha256 !== s.manifestSha256
      || i.submissionManifestSha256 !== c.link.submissionManifestSha256 || !/^[0-9a-f]{64}$/.test(v.materialSha256)
      || !i.snapshotRevision || !i.validatorVersion || !/^(?:sha256:)?[0-9a-f]{64}$/.test(i.diagnosticsSha256)
      || !Array.isArray(v.requiredAcknowledgements) || v.requiredAcknowledgements.length > 200
      || new Set(v.requiredAcknowledgements).size !== v.requiredAcknowledgements.length
      || v.requiredAcknowledgements.some((f) => !/^[0-9a-f]{32}$/.test(f)) || typeof v.selfApprovalRequired !== 'boolean')
      throw new Error('Readiness does not match the selected current candidate and finalized submission. Refresh the lists and review again.');
  }
  export function requireUnchangedReadiness(reviewed: ReadinessView, fresh: ReadinessView): void {
    if (canonicalJson(reviewed) !== canonicalJson(fresh)) throw new Error('Readiness changed. Refresh and deliberately review the exact version and warnings again. Draft reasons were kept.');
  }
  export function signoffPayload(v: ReadinessView, operationId: string, reasons: Record<string, string>, selfApproval: boolean, reviewedVersion: string) {
    if (v.blocker || reviewedVersion !== v.identity.resultsVersion) throw new Error('Review and confirm this exact unblocked results version first.');
    if (selfApproval !== v.selfApprovalRequired) throw new Error('Confirm self-approval only when you prepared this candidate.');
    const acknowledgements = v.requiredAcknowledgements.map((fingerprint) => {
      const reason = reasons[fingerprint]?.trim();
      if (!reason || reason.length > 1000) throw new Error('Each required warning needs a reason of 1–1000 characters.');
      return { fingerprint, reason };
    });
    const { candidateId, ...identity } = v.identity;
    return { operationId, candidateId, identity, acknowledgements, selfApproval };
  }
  export function publishPayload(v: ReadinessView, operationId: string, expected: PublicationState, reviewedVersion: string) {
    const so = v.signoff;
    if (v.blocker || reviewedVersion !== v.identity.resultsVersion || !so || so.state !== 'audited' || so.invalidated || so.blockers.length
      || canonicalJson(so.identity) !== canonicalJson(v.identity)) throw new Error('Publication requires the exact current, audited sign-off and a separate version confirmation.');
    return { operationId, signoffId: so.signoffId, expected };
  }
</script>

<script lang="ts">
  import { onMount, untrack } from 'svelte';
  let { data }: { data: WorkbenchData } = $props();
  let submissions = $state<OperatorSubmissionView[]>(untrack(() => data.submissions));
  let candidates = $state<LinkedCandidate[]>(untrack(() => data.candidates));
  let submissionId = $state(''), candidateId = $state('');
  let packageFiles = $state<Record<string, string> | null>(null);
  let packageNames = $state<string[]>([]);
  let busy = $state(false), hydrated = $state(false), status = $state('');
  let detail = $state('');
  let readiness = $state<ReadinessView | null>(null), signoffId = $state('');
  let reasons = $state<Record<string, string>>({}), selfApproval = $state(false);
  let reviewedVersion = $state(''), publishVersion = $state('');
  let importOperation = $state(''), correctionOperation = $state(''), signoffOperation = $state(''), publishOperation = $state('');
  let correctionReason = $state(''), replacements = $state('[\n  { "key": "matter", "data": {} }\n]');
  let expectedKind = $state(''), expectedVersion = $state('');
  let pending = $state<Pending | null>(null);
  const casePath = $derived(`/operator/results/${encodeURIComponent(data.caseId)}`);
  const publicationPath = $derived(`/operator/publication/${encodeURIComponent(data.caseId)}`);
  const newOperation = () => crypto.randomUUID();
  onMount(() => {
    hydrated = true;
    importOperation = newOperation(); correctionOperation = newOperation(); signoffOperation = newOperation(); publishOperation = newOperation();
  });
  const chosenSubmission = $derived(submissions.find((s) => s.revisionId === submissionId));
  const chosenCandidate = $derived(candidates.find((c) => c.candidateId === candidateId));
  function invalidateReview() { readiness = null; reviewedVersion = ''; publishVersion = ''; selfApproval = false; }
  function selectionChanged() { invalidateReview(); signoffId = ''; }
  async function jsonRequest(path: string, body?: unknown) {
    let r: Response;
    try { r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    catch { throw new Error('Network failure. Outcome is unconfirmed; keep the operation id and retry the unchanged request.'); }
    let value;
    try { value = await r.json(); } catch { throw new Error(`HTTP ${r.status}: invalid JSON response. Outcome is unconfirmed.`); }
    if (!r.ok) {
      // Never log or echo the request/package. These are the controller's text-only response fields.
      const failure = new Error(`HTTP ${r.status} ${value.code ?? 'request-failed'}: ${value.message ?? 'Request refused.'}`);
      if (body !== undefined && r.status < 500) pending = null;
      detail = JSON.stringify(value, null, 2);
      throw failure;
    }
    return { status: r.status, value };
  }
  async function run(work: () => Promise<void>) {
    busy = true;
    try { await work(); } catch (e) { status = e instanceof Error ? e.message : 'Request failed; drafts were kept.'; }
    finally { busy = false; }
  }
  async function refreshLists() {
    await run(async () => {
      invalidateReview();
      const s = await jsonRequest(`/operator/submissions/${encodeURIComponent(data.caseId)}/finalized`);
      const c = await jsonRequest(`${casePath}/candidates`);
      submissions = s.value.submissions; candidates = c.value.candidates;
      status = 'Finalized submissions and private candidate list refreshed. No processing was run.';
    });
  }
  async function chooseFolder(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    await run(async () => {
      packageFiles = null; packageNames = [];
      const files = Array.from(input.files ?? []);
      if (!files.length || files.length > 200) throw new Error('Select a prepared results-package folder with 1–200 files.');
      if (files.reduce((n, f) => n + f.size, 0) > 24 * 1024 * 1024) throw new Error('This workbench accepts up to 24 MiB; the server may enforce a smaller budget.');
      const map: Record<string, string> = Object.create(null);
      for (const f of files) {
        const relative = f.webkitRelativePath;
        const path = relative.substring(relative.indexOf('/') + 1);
        if (!relative.includes('/') || !(path === 'manifest.json' || path === 'assets.json' || /^datasets\/[a-z][a-z0-9-]*\.json$/.test(path)) || Object.hasOwn(map, path))
          throw new Error('Select the package root containing only manifest.json, assets.json and datasets/*.json. ZIP, HTML, PDFs and arbitrary folders are unsupported.');
        // Fatal UTF-8 decoding preserves text exactly, including a BOM for the real validator to refuse.
        map[path] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await f.arrayBuffer());
      }
      if (!map['manifest.json'] || !map['assets.json']) throw new Error('The package root must include manifest.json and assets.json.');
      packageFiles = map; packageNames = Object.keys(map).sort();
      status = `${files.length} already-processed package files selected. No conversion or processing was performed.`;
    });
  }
  async function readFresh(signoff = signoffId): Promise<ReadinessView> {
    if (!chosenCandidate || !chosenSubmission) throw new Error('Select a finalized submission and private candidate first.');
    const q = new URLSearchParams({ candidateId, ...(signoff ? { signoffId: signoff } : {}) });
    const r = await jsonRequest(`${publicationPath}/readiness?${q}`);
    const view = r.value as ReadinessView;
    assertReadiness(view, data.caseId, chosenCandidate, chosenSubmission);
    if (signoff && view.signoff?.signoffId !== signoff) throw new Error('Readiness did not return the exact requested sign-off.');
    return view;
  }
  async function refreshReadiness() {
    await run(async () => {
      invalidateReview();
      readiness = await readFresh();
      status = 'Exact readiness observations refreshed. Review the identity and warnings; this is not an approval.';
    });
  }
  async function performPending() {
    if (!pending) return;
    const request = pending;
    const r = await jsonRequest(request.path, request.body);
    // No state, id rotation, or retry cleanup until the COMPLETE success matches the frozen submitted identity.
    try {
      if ((request.kind === 'import' || request.kind === 'correction') && (r.value?.kind !== 'linked' || !r.value.candidate))
        throw new Error('The response did not confirm a linked candidate.');
      await assertOperationSuccess(request, r.status, r.value);
    }
    catch { throw new Error(`HTTP ${r.status}: the response did not confirm the exact ${request.kind} outcome. Outcome is unconfirmed; retry the identical request with the same operation id.`); }
    // A controller response, not candidate status or pointer equality, is the only success displayed.
    detail = JSON.stringify(r.value, null, 2);
    status = `HTTP ${r.status}: ${request.kind} controller confirmed the response below.`;
    pending = null;
    invalidateReview();
    if (request.kind === 'signoff') {
      signoffId = r.value.signoffId;
      signoffOperation = newOperation();
    } else if (request.kind === 'import' || request.kind === 'correction') {
      const c = r.value.candidate as LinkedCandidate;
      candidates = [c, ...candidates.filter((old) => old.candidateId !== c.candidateId).map((old) => old.candidateId === c.parentCandidateId ? { ...old, current: false, supersededBy: c.candidateId } : old)];
      candidateId = c.candidateId; signoffId = '';
      if (request.kind === 'import') importOperation = newOperation(); else correctionOperation = newOperation();
    } else publishOperation = newOperation();
  }
  async function importPackage() {
    await run(async () => {
      if (!chosenSubmission || !packageFiles) throw new Error('Select a finalized submission and an already-processed results package.');
      const s = chosenSubmission, files = packageFiles;
      const manifest = JSON.parse(files['manifest.json']);
      const expected: ImportExpectation = { clientId: s.clientId, caseId: data.caseId, submissionRevisionId: s.revisionId,
        submissionManifestSha256: s.manifestSha256, resultsVersion: manifest.resultsVersion,
        manifestSha256: await sha256Text(files['manifest.json']), packageInputRevisionId: manifest.inputRevision?.id };
      pending = { path: `${casePath}/imports`, kind: 'import', expected,
        body: { operationId: importOperation, submissionRevisionId: s.revisionId, files: { ...files } } };
      await performPending();
    });
  }
  async function correct() {
    await run(async () => {
      if (!chosenCandidate?.current || !correctionReason.trim()) throw new Error('Choose a current candidate and supply a correction reason.');
      const parsed: unknown = JSON.parse(replacements);
      if (!Array.isArray(parsed)) throw new Error('Replacements must be a JSON array of {key, data}.');
      pending = { path: `${casePath}/candidates/${encodeURIComponent(candidateId)}/corrections`, kind: 'correction',
        expected: JSON.parse(JSON.stringify(chosenCandidate)), body: { operationId: correctionOperation, reason: correctionReason, replacements: parsed } };
      await performPending();
    });
  }
  async function signOff() {
    await run(async () => {
      if (!readiness) throw new Error('Refresh readiness and review it first.');
      const reviewed = readiness;
      const payload = signoffPayload(reviewed, signoffOperation, reasons, selfApproval, reviewedVersion);
      const fresh = await readFresh();
      try { requireUnchangedReadiness(reviewed, fresh); } catch (e) { invalidateReview(); throw e; }
      pending = { path: `${publicationPath}/signoffs`, kind: 'signoff', body: payload };
      await performPending();
    });
  }
  async function publish() {
    await run(async () => {
      if (!readiness) throw new Error('Refresh readiness with the audited sign-off first.');
      if (!['none', 'published', 'withdrawn'].includes(expectedKind)) throw new Error('Explicitly select the expected publication state. The server will compare it atomically.');
      if (expectedKind !== 'none' && !/^sha256:[0-9a-f]{64}$/.test(expectedVersion)) throw new Error('Supply the exact expected current resultsVersion.');
      const expected = (expectedKind === 'none' ? { kind: 'none' } : { kind: expectedKind, resultsVersion: expectedVersion }) as PublicationState;
      const reviewed = readiness;
      const payload = publishPayload(reviewed, publishOperation, expected, publishVersion);
      const fresh = await readFresh();
      try { requireUnchangedReadiness(reviewed, fresh); } catch (e) { invalidateReview(); throw e; }
      pending = { path: `${publicationPath}/publish`, kind: 'publish', body: payload, expected: { resultsVersion: reviewed.identity.resultsVersion } };
      await performPending();
    });
  }
</script>

<svelte:head><title>Synthetic operator workbench</title></svelte:head>
<main data-operator-workbench="synthetic">
  <h1>Synthetic operator workbench</h1>
  <p>Case <strong>{data.caseId}</strong>. Upload already-processed results, review privately, sign off, then separately publish. Nothing here runs processing or proves processing lineage.</p>
  <noscript><p>This workbench requires JavaScript. No operation was submitted. Use the authorized JSON APIs or enable JavaScript.</p></noscript>
  {#if data.submissionFailure}<p role="alert">HTTP {data.submissionFailure.status} {data.submissionFailure.code}: {data.submissionFailure.message}</p>{/if}
  {#if data.candidateFailure}<p role="alert">HTTP {data.candidateFailure.status} {data.candidateFailure.code}: {data.candidateFailure.message}</p>{/if}
  <p role="status" aria-live="polite">{busy ? 'Request in progress…' : status}</p>
  {#if detail}<details open><summary>Last controller response (not processing proof)</summary><pre>{detail}</pre></details>{/if}
  <fieldset disabled={!hydrated || busy}>
    <legend>Private operator actions</legend>
    <button type="button" onclick={refreshLists}>Refresh submissions and candidates</button>
    <a href={`/operator/submissions/${encodeURIComponent(data.caseId)}`}>Submission download page</a>
    {#if pending}
      <section aria-label="Unconfirmed operation">
        <p>The last operation is unconfirmed. Drafts and the exact request were kept in this page. Do not create a new operation to guess its outcome. Retry unchanged so the server can reconcile it. Closing this page loses the in-memory retry.</p>
        <pre>{JSON.stringify({ kind: pending.kind, operationId: (pending.body as { operationId: string }).operationId }, null, 2)}</pre>
        <button type="button" onclick={() => run(performPending)}>Retry unchanged request</button>
      </section>
    {/if}
    <fieldset disabled={pending !== null}>
      <legend>1. Select finalized input and upload prepared results</legend>
      <label>Finalized submission
        <select bind:value={submissionId} onchange={selectionChanged}>
          <option value="">Select a finalized submission</option>
          {#each submissions as s (s.revisionId)}<option value={s.revisionId}>Submission {s.sequence} — {s.revisionId}</option>{/each}
        </select>
      </label>
      {#if chosenSubmission}
        <p>Manifest SHA-256: <code>{chosenSubmission.manifestSha256}</code></p>
        <a href={chosenSubmission.manifestHref} download>Download exact manifest</a> · <a href={chosenSubmission.downloadHref} download>Download submitted PDF</a>
      {/if}
      <label>Already-processed results-package folder <input type="file" multiple webkitdirectory onchange={chooseFolder} /></label>
      <p>Accepted transport: package-relative path → exact UTF-8 text, sent as the existing API's files object. Select the root containing manifest.json, assets.json and datasets/*.json. No ZIP, workspace HTML or processing recipes.</p>
      {#if packageNames.length}<details><summary>{packageNames.length} selected files</summary><pre>{packageNames.join('\n')}</pre></details>{/if}
      <label>Import operation id <input bind:value={importOperation} /></label>
      <button type="button" disabled={!chosenSubmission || !packageFiles} onclick={importPackage}>Import privately — do not publish</button>
    </fieldset>
    <fieldset disabled={pending !== null}>
      <legend>2. Inspect a private candidate</legend>
      <label>Candidate
        <select bind:value={candidateId} onchange={selectionChanged}>
          <option value="">Select a private candidate</option>
          {#each candidates as c (c.candidateId)}<option value={c.candidateId}>{c.current ? 'Current' : 'Not current'} — {c.candidateId} — {c.link.candidate.resultsVersion}</option>{/each}
        </select>
      </label>
      {#if chosenCandidate}
        <p>Private candidate: {chosenCandidate.current ? 'current and durably audited' : 'not current; not eligible for this workbench sign-off'}. Origin: {chosenCandidate.origin}.</p>
        {#if chosenCandidate.current}<p><a data-action="open-private-preview" href={`/operator/cases/${encodeURIComponent(data.caseId)}/preview/${encodeURIComponent(chosenCandidate.candidateId)}`}>Open private preview of {chosenCandidate.link.candidate.resultsVersion} (not published)</a></p>{/if}
        <details open><summary>Exact candidate link and correction details</summary><pre>{JSON.stringify(chosenCandidate, null, 2)}</pre></details>
        <details><summary>Reasoned correction of authored datasets (advanced)</summary>
          <p>Each replacement is {`{key, data}`}. Generated datasets and originals cannot be edited. A saved correction creates a new candidate requiring fresh review.</p>
          <label>Replacements JSON <textarea rows="8" bind:value={replacements}></textarea></label>
          <label>Correction reason <textarea maxlength="500" bind:value={correctionReason}></textarea></label>
          <label>Correction operation id <input bind:value={correctionOperation} /></label>
          <button type="button" disabled={!chosenCandidate.current} onclick={correct}>Save new corrected candidate</button>
        </details>
      {/if}
    </fieldset>
    <fieldset disabled={pending !== null}>
      <legend>3. Review exact readiness and deliberately sign off</legend>
      <label>Exact sign-off id (optional until signed) <input bind:value={signoffId} oninput={invalidateReview} /></label>
      <button type="button" disabled={!chosenSubmission || !chosenCandidate?.current} onclick={refreshReadiness}>Refresh exact readiness</button>
      {#if readiness}
        <pre>{JSON.stringify(readiness.identity, null, 2)}</pre>
        <p>Material digest: <code>{readiness.materialSha256}</code>. This observation is not an approval or publication.</p>
        {#if readiness.blocker}<p role="alert">Blocked: {readiness.blocker.code}</p><ul>{#each readiness.blocker.detail as d}<li>{d}</li>{/each}</ul>{/if}
        <h2>Required warning acknowledgements</h2>
        {#each readiness.requiredAcknowledgements as fingerprint (fingerprint)}
          <label><code>{fingerprint}</code> — reason for accepting this warning <textarea maxlength="1000" bind:value={reasons[fingerprint]}></textarea></label>
        {:else}<p>No new warning acknowledgements required by this exact snapshot.</p>{/each}
        {#if readiness.selfApprovalRequired}<label><input type="checkbox" bind:checked={selfApproval} /> I prepared this candidate and deliberately approve my own work in this separate action.</label>{/if}
        <label>Type the exact resultsVersion you reviewed <input bind:value={reviewedVersion} autocomplete="off" /></label>
        <label>Sign-off operation id <input bind:value={signoffOperation} /></label>
      {/if}
      <button type="button" disabled={!readiness || readiness.blocker !== null} onclick={signOff}>Record exact sign-off — do not publish</button>
    </fieldset>
    <fieldset disabled={pending !== null || !readiness?.signoff || readiness.signoff.state !== 'audited' || readiness.signoff.invalidated || readiness.signoff.blockers.length > 0 || readiness.blocker !== null}>
      <legend>4. Separately publish the exact audited sign-off</legend>
      <p>After signing, refresh readiness with its exact sign-off id. Publication is never automatic. The expected pointer below is your explicit compare-and-set expectation, not an inferred current publication.</p>
      {#if readiness?.signoff}<pre>{JSON.stringify(readiness.signoff, null, 2)}</pre>{/if}
      <label>Expected current publication
        <select bind:value={expectedKind}><option value="">Select explicitly</option><option value="none">No publication</option><option value="published">Published version</option><option value="withdrawn">Withdrawn version</option></select>
      </label>
      {#if expectedKind && expectedKind !== 'none'}<label>Expected current resultsVersion <input bind:value={expectedVersion} /></label>{/if}
      <label>Type the exact resultsVersion to publish <input bind:value={publishVersion} autocomplete="off" /></label>
      <label>Publication operation id <input bind:value={publishOperation} /></label>
      <button type="button" onclick={publish}>Publish this exact audited sign-off</button>
    </fieldset>
  </fieldset>
</main>

<style>
  main { max-width: 70rem; margin: 1rem auto; padding: 1rem; font-family: system-ui, sans-serif; }
  fieldset { margin-block: 1rem; border: 1px solid #8b93a0; border-radius: .4rem; padding: 1rem; min-width: 0; }
  legend { font-weight: 700; }
  label { display: block; margin-block: .8rem; }
  input:not([type='checkbox']), select, textarea { display: block; width: 100%; box-sizing: border-box; padding: .5rem; }
  button, a { margin: .5rem .5rem .5rem 0; }
  button { padding: .6rem; }
  pre, code { white-space: pre-wrap; overflow-wrap: anywhere; }
  p[role='alert'] { border-left: .3rem solid #b91c1c; padding-left: .7rem; }
</style>
