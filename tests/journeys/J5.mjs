import { run, direct, ready, check, countDomainRows, MODE } from './lib.mjs';
export const views = {
  analysis: ['matter', 'timeline', 'contradictions_tab', 'risk_matrix_tab', 'vdm_matrix_tab', 'info_required_tab', 'witness_tab'],
  evidence: ['people', 'entity_ledger_tab', 'contracts_tab', 'filings_tab'],
  litigation: ['conflict_tab', 'enforcement_tab', 'legality_tab', 'elements_tab', 'authorities_tab', 'heads_tab', 'crossexam_tab'],
  quantum: ['quantum_tab', 'invoice_ledger_tab', 'prescription_tab', 'interest_calc_tab', 'payments_tab', 'settlement_tab'],
};
// HEADS_EXPECTED, when set, is how many Heads entries the case under test holds (0: the documented empty state).
const HEADS_EXPECTED = (process.env.HEADS_EXPECTED || '').trim() ? Number(process.env.HEADS_EXPECTED) : null;
// In the page: the visible empty states, narrative and timeline events `main` holds (rows: countDomainRows).
const visibleContent = main => {
  const shown = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const text = sel => [...main.querySelectorAll(sel)].filter(shown).map(e => e.innerText.trim()).join('');
  return {
    emptyStates: [...main.querySelectorAll('tbody .empty')].filter(shown).length,
    narrative: text('.narrative'), matter: text('#matter-storyline-card .narrative, #matter-storyline-card p'),
    events: [...main.querySelectorAll('[data-phase] [role="listitem"] a[href]')].filter(shown).length,
  };
};
export const journey = () => run('J5', async j => {
  for (const [category, ids] of Object.entries(views)) for (const id of ids) await j.attempt(id, async () => {
    await j.measure(id, () => j.page.goto(j.url(`${category}/${id}`), { waitUntil: 'domcontentloaded' }), async () => {
      await ready(j.page, id);
      const main = j.page.locator(`main[data-ready="${id}"]`);
      const seen = { ...await main.evaluate(visibleContent), rows: await main.evaluate(countDomainRows) };
      // The hosted page wraps the view's main in analysis-content (deploy/client/routes/.../<view>/+page.svelte); a local page may hold it inside.
      const hook = j.page.locator(`[data-testid="analysis-content"]:has(main[data-ready="${id}"]), main[data-ready="${id}"] [data-testid="analysis-content"]`);
      const hooks = await hook.count();
      check(hooks <= 1 && (hooks === 1 || MODE !== 'hosted'), 'Analysis content hook missing around the hosted view');
      // Heads is the one view whose case can legitimately be empty: the package imports no submissions (README, "Heads entries").
      const emptyHeads = id === 'heads_tab' && (HEADS_EXPECTED === null ? seen.rows === 0 : HEADS_EXPECTED === 0);
      if (id === 'matter') {
        check(seen.matter.length > 0 && seen.narrative.length > 0, 'Matter narrative empty');
      } else if (id === 'timeline') {
        check(seen.events > 0, 'Timeline has no cited events');
      } else if (id === 'conflict_tab') {
        check(await main.locator('#confsel').isVisible() && await main.locator('#confsel option').count() > 1, 'Conflict view has no people/entities');
      } else if (id === 'interest_calc_tab') {
        check(seen.narrative.length > 0, 'Interest view has no imported narrative');
      } else if (id === 'heads_tab') {
        // Heads of argument are the lawyer's own entries; the package imports none. The form must work. HEADS_EXPECTED pins the
        // entries the case holds; unset, a fresh case's empty state and an edited case's rows are both the view working.
        const form = main.locator('form#hd-add');
        check(await form.count() === 1 && await form.isVisible(), 'Heads view has no add form');
        const fields = form.locator('input:not([type="hidden"])');
        check(await fields.count() >= 1 && (await fields.evaluateAll(fs => fs.every(f => !f.disabled && !f.readOnly && f.getClientRects().length > 0))), 'Heads add form has no usable fields');
        check(await form.locator('button[type="submit"]').isEnabled(), 'Heads add form cannot be submitted');
        if (HEADS_EXPECTED === null) check(seen.rows > 0 || seen.emptyStates === 1, 'Heads view shows neither entries nor its empty state');
        else if (HEADS_EXPECTED === 0) check(seen.rows === 0 && seen.emptyStates === 1, 'Heads view does not show its empty state (HEADS_EXPECTED=0)');
        else check(seen.rows === HEADS_EXPECTED && seen.emptyStates === 0, `Heads view shows ${seen.rows} entries, expected ${HEADS_EXPECTED}`);
      } else if (id === 'settlement_tab') {
        const input = main.locator('#se_claim');
        check(await input.isVisible() && Number((await input.inputValue()).replace(/,/g, '')) > 0, 'Calculator has no imported principal/claim');
        check(await main.locator('#se_out').isVisible() && (await main.locator('#se_out').innerText()).trim().length > 0 && !await main.locator('#se-error').count(), 'Calculator has no computed output');
      } else {
        check(seen.rows > 0, 'Analysis has no visible populated data rows');
      }
      if (hooks) check(await hook.isVisible() && await hook.getAttribute('data-empty') === String(emptyHeads), 'Analysis content missing or flagged empty');
    });
  });
  j.metadata.analysisViews = Object.values(views).flat().length;
});
if (direct(import.meta.url)) await journey();
