# GRS-194 presentation and verification plan

User authorization: 22 October 2026, implement and test the four omissions before the GRS-24 contract decision. This does not approve that contract or GRS-27.

Base: `e05d9a8175afd12aacbf580ce29bbb50829ecf15`. Ticket branch `feature/grs-194-compat-presentation` targets `wave/compat-presentation`; the wave targets `dev`.

## Reservations

- `src/lib/case-package/records.ts`, `registry.ts` and generated schemas: recognize anchors, organogram, date-bounded phases and the retained count-free checks, preserving source values.
- `src/lib/views/analysis/timeline.ts`, its tests, a new `supplemental.ts` model and `SupplementalAnalysis.svelte`: explicit phase assignment and accessible anchors/relationships.
- `src/routes/v/[vid]/analysis/matter/+page.server.ts` and `+page.svelte`: anchors and organogram inside the existing Matter & Strategy view.
- `src/routes/v/[vid]/analysis/timeline/+page.server.ts` and `+page.svelte`: date phases without year-based assignment.
- `src/lib/views/analysis/contradictions.ts` and `src/routes/v/[vid]/analysis/contradictions_tab/+page.server.ts`: expose validated count-free checks alongside counted checks.
- Corresponding synthetic tests under `tests/case-package/`, `tests/e2e/analysis/` and `tests/acceptance/CC-25/`; package contract and compatibility documentation.
- `scripts/case-package/schema-check.ts` and `tests/case-package/fixtures/{presentation,malform}.ts`: extend independent schema exhaustiveness checks for the newly recognized datasets and phase union without altering the baseline v5 fixture.

No hosted route/configuration edits. No new navigation destination: retain 42 views. A local view does not establish hosted coverage.

## Test recipe

1. Convert a synthetic newer V1 source: anchors, nodes, connections, keyed date phases and count-free checks reach recognized datasets unchanged. Malformed required fields remain residual with diagnostics; executable source is never evaluated.
2. Validate a package with bad types, duplicate phase/node identities, dangling connections and missing phase references: refuse invalid shapes or disclose unresolved references; never guess an identity, silently drop a row or duplicate an event.
3. Group events by their explicit phase key even where date ranges overlap; unknown keys remain visible outside phases. Existing year-based v5 grouping stays unchanged.
4. Render Matter & Strategy: anchor text/quote/page citation and every node/connection are readable; unknown refs stay visibly unresolved; hostile text is escaped. Verify the same through the real app in Chromium, including a citation click.
5. Render timeline and consistency checks: every fixture event and check appears, with no invented numeric count; v5 checks and phase rendering retain prior behavior.
6. Run package/unit tests, schema export verification, type/Svelte checks and build through receipts. At the clean candidate SHA run the required gate and the verification skill. Run CC-25 against real v5/newer/JSON samples when available, retaining the exact receipt and revision.
7. Fresh independent standards/spec review, bounded fix and recheck. Report each acceptance boundary separately; missing or unsupported checks stay HOLD/UNRUN.

## Environment

Parent workspace instructions and private orchestration evidence are absent on this Windows host. WSL has only Docker Desktop; the default `bash` launch fails. A dedicated Linux container is being prepared under the user-requested Desktop `ClearCase Acceptance/runner`. `private-samples/v5`, `newer` and `json` are initially empty. No synthetic fixture substitutes for the real-export gate. Do not commit private samples, reports or credentials.
