import { run, direct, ready, check } from './lib.mjs';
export const views = {
  analysis: ['matter', 'timeline', 'contradictions_tab', 'risk_matrix_tab', 'vdm_matrix_tab', 'info_required_tab', 'witness_tab'],
  evidence: ['people', 'entity_ledger_tab', 'contracts_tab', 'filings_tab'],
  litigation: ['conflict_tab', 'enforcement_tab', 'legality_tab', 'elements_tab', 'authorities_tab', 'heads_tab', 'crossexam_tab'],
  quantum: ['quantum_tab', 'invoice_ledger_tab', 'prescription_tab', 'interest_calc_tab', 'payments_tab', 'settlement_tab'],
};
export const journey = () => run('J5', async j => {
  for (const [category, ids] of Object.entries(views)) for (const id of ids) await j.attempt(id, async () => {
    await j.measure(id, () => j.page.goto(j.url(`${category}/${id}`), { waitUntil: 'domcontentloaded' }), async () => {
      await ready(j.page, id);
      const main = j.page.locator(`main[data-ready="${id}"]`);
      const hook = main.locator('[data-testid="analysis-content"]');
      if (await hook.count()) {
        check(await hook.isVisible() && (await hook.innerText()).trim().length > 0 && await hook.getAttribute('data-empty') === 'false', 'Analysis content missing or empty');
      } else if (id === 'matter') {
        check((await main.locator('#matter-storyline-card .narrative, #matter-storyline-card p').allTextContents()).join('').trim().length > 0, 'Matter narrative empty');
      } else if (id === 'timeline') {
        check(await main.locator('[data-phase] [role="listitem"] a').count() > 0, 'Timeline has no cited events');
      } else if (id === 'conflict_tab') {
        check(await main.locator('#confsel option').count() > 1, 'Conflict view has no people/entities');
      } else if (id === 'interest_calc_tab') {
        check((await main.locator('.narrative').allTextContents()).join('').trim().length > 0, 'Interest view has no imported narrative');
      } else if (id === 'settlement_tab') {
        const input = main.locator('#se_claim');
        check(Number((await input.inputValue()).replace(/,/g, '')) > 0, 'Calculator has no imported principal/claim');
        check((await main.locator('#se_out').innerText()).trim().length > 0 && !await main.locator('#se-error').count(), 'Calculator has no computed output');
      } else {
        const populated = await main.locator('tbody tr').evaluateAll(rows => rows.some(r => r.querySelectorAll('td').length >= 2 && r.textContent.trim().length > 0));
        check(populated, 'Analysis has no populated data rows');
      }
    });
  });
  j.metadata.analysisViews = Object.values(views).flat().length;
});
if (direct(import.meta.url)) await journey();
