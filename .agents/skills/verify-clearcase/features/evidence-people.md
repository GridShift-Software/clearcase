# People and Entities (evidence)

People lists the correspondents and signatories inferred from e-mail headers (name, address, organisation, sent, received, total), in data order, with raw values. Entities lists the companies and bodies with their imported role and note. Both say the identities and roles are inferred and unverified (BA-07); People marks a machine-looking address as `automated address` and shows a Role column only when the package supplies a role, headed `Role (inferred, unverified)`.

## How to get to it (user POV)

- Choose `People` (`#nav-people`) or `Entities` (`#nav-entity_ledger_tab`); or open `/v/<rv>/evidence/people` or `/v/<rv>/evidence/entity_ledger_tab`.

## Driving it with verify-clearcase

- **Open.** `main[data-ready=people]` (or `entity_ledger_tab`), heading focused, `#identity-status[data-verification=unverified]`.
- **Automated sender.** A row with `data-automated=true` keeps its raw `.addr` and organisation and carries no badge or verified label.

## Gotchas

- Nothing here is reviewed identity data; never assert a role as a fact.
