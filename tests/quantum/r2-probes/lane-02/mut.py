# usage: python3 -I mut.py <worktree> <mutant-id>  -- applies one exact replacement (must match once)
import sys
M = {
 'M1-parsefloat-sum': ('src/lib/views/quantum/payments.ts', "const paid = rows.reduce((a, r) => a + (r.amountCents ?? 0n), 0n);", "const paid = rows.reduce((a, r) => a + BigInt(Math.round((parseFloat(r.amount) || 0) * 100)), 0n);"),
 'M1b-drop-cents-sum': ('src/lib/views/quantum/payments.ts', "const paid = rows.reduce((a, r) => a + (r.amountCents ?? 0n), 0n);", "const paid = rows.reduce((a, r) => a + ((r.amountCents ?? 0n) / 100n) * 100n, 0n);"),
 'M2-lt-for-le': ('src/lib/views/quantum/prescription.ts', "r.prescDate <= asOf ? 'passed'", "r.prescDate < asOf ? 'passed'"),
 'M3-tofixed-rounding': ('src/lib/calculations/money.ts', "export const unitsToCents = (u: bigint): bigint => divRound(u, 100n);", "export const unitsToCents = (u: bigint): bigint => BigInt((Number(u) / 10000).toFixed(2).replace('.', ''));"),
 'M4-drop-feb29-rule': ('src/lib/calculations/dates.ts', "return iso(y, p[1], Math.min(p[2], daysInMonth(y, p[1])));", "return iso(y, p[1], p[2]);"),
 'M5-link-by-url': ('src/routes/v/[vid]/quantum/prescription_tab/+page.svelte', "<td><CitationLink resultsVersion={vid} ref={r.ref} exists={known.has(r.ref)} label={known.has(r.ref) ? 'open ↗' : r.ref} /></td>", "<td><a class=\"cite\" href={r.url}>open ↗</a></td>"),
 'M6-broken-as-link': ('src/routes/v/[vid]/quantum/invoice_ledger_tab/+page.svelte', "<CitationLink resultsVersion={vid} ref={r.ref} exists={known.has(r.ref)} label={known.has(r.ref) ? 'open ↗' : r.ref} />", "<CitationLink resultsVersion={vid} ref={r.ref} exists={true} label={'open ↗'} />"),
 'M7-asof-text-swap': ('src/lib/views/quantum/prescription.ts', "passed: '3-yr date passed', 'not-reached': '3-yr date not reached'", "passed: '3-yr date not reached', 'not-reached': '3-yr date passed'"),
}
root, ids = sys.argv[1], sys.argv[2:]
for i in ids:
    f, a, b = M[i]
    p = f"{root}/{f}"; t = open(p, encoding='utf8').read()
    n = t.count(a)
    if n != 1: sys.exit(f"{i}: matched {n} times in {f}")
    open(p, 'w', encoding='utf8').write(t.replace(a, b)); print(f"applied {i} to {f}")
