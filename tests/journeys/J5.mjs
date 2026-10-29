import { run, direct, ready, check, MODE } from './lib.mjs';
export const views = {
  analysis: ['matter', 'timeline', 'contradictions_tab', 'risk_matrix_tab', 'vdm_matrix_tab', 'info_required_tab', 'witness_tab'],
  evidence: ['people', 'entity_ledger_tab', 'contracts_tab', 'filings_tab'],
  litigation: ['conflict_tab', 'enforcement_tab', 'legality_tab', 'elements_tab', 'authorities_tab', 'heads_tab', 'crossexam_tab'],
  quantum: ['quantum_tab', 'invoice_ledger_tab', 'prescription_tab', 'interest_calc_tab', 'payments_tab', 'settlement_tab'],
};
// In the page: what `main` visibly holds. A row counts when it is shown, has two cells and text, and is not an empty or error row.
const visibleContent = main => {
  const shown = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const text = sel => [...main.querySelectorAll(sel)].filter(shown).map(e => e.innerText.trim()).join('');
  return {
    rows: [...main.querySelectorAll('tbody tr')].filter(r => shown(r) && r.querySelectorAll('td').length >= 2 && !r.querySelector('.empty, .error, [role="alert"]') && r.innerText.trim()).length,
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
      const seen = await main.evaluate(visibleContent);
      // The hosted page wraps the view's main in analysis-content (deploy/client/routes/.../<view>/+page.svelte); a local page may hold it inside.
      const hook = j.page.locator(`[data-testid="analysis-content"]:has(main[data-ready="${id}"]), main[data-ready="${id}"] [data-testid="analysis-content"]`);
      const hooks = await hook.count();
      check(hooks <= 1 && (hooks === 1 || MODE !== 'hosted'), 'Analysis content hook missing around the hosted view');
      // Heads is the one view whose fresh case is legitimately empty: the package imports no submissions (README, "Fresh-case Heads").
      const freshHeads = id === 'heads_tab' && seen.rows === 0;
      if (hooks) check(await hook.isVisible() && await hook.getAttribute('data-empty') === String(freshHeads), 'Analysis content missing or flagged empty');
      if (id === 'matter') {
        check(seen.matter.length > 0 && seen.narrative.length > 0, 'Matter narrative empty');
      } else if (id === 'timeline') {
        check(seen.events > 0, 'Timeline has no cited events');
      } else if (id === 'conflict_tab') {
        check(await main.locator('#confsel').isVisible() && await main.locator('#confsel option').count() > 1, 'Conflict view has no people/entities');
      } else if (id === 'interest_calc_tab') {
        check(seen.narrative.length > 0, 'Interest view has no imported narrative');
      } else if (id === 'heads_tab') {
        // Heads of argument are the lawyer's own entries; the package imports none. A fresh case shows the add form and
        // the documented empty state, and an edited one shows rows: either is the view working, and the form must work.
        const form = main.locator('form#hd-add');
        check(await form.count() === 1 && await form.isVisible(), 'Heads view has no add form');
        const fields = form.locator('input:not([type="hidden"])');
        check(await fields.count() >= 1 && (await fields.evaluateAll(fs => fs.every(f => !f.disabled && !f.readOnly && f.getClientRects().length > 0))), 'Heads add form has no usable fields');
        check(await form.locator('button[type="submit"]').isEnabled(), 'Heads add form cannot be submitted');
        check(seen.rows > 0 || seen.emptyStates === 1, 'Heads view shows neither entries nor its empty state');
      } else if (id === 'settlement_tab') {
        const input = main.locator('#se_claim');
        check(await input.isVisible() && Number((await input.inputValue()).replace(/,/g, '')) > 0, 'Calculator has no imported principal/claim');
        check(await main.locator('#se_out').isVisible() && (await main.locator('#se_out').innerText()).trim().length > 0 && !await main.locator('#se-error').count(), 'Calculator has no computed output');
      } else {
        check(seen.rows > 0, 'Analysis has no visible populated data rows');
      }
    });
  });
  j.metadata.analysisViews = Object.values(views).flat().length;
});
if (direct(import.meta.url)) await journey();
