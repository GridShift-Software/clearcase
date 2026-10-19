# Access: deny a wrong-client request

A deployment serves one client, named by its `CLEARCASE_CLIENT_ID` var, never by a request. A session of another client is refused as `wrong-client` on every protected page and asset, with a generic denial and no case data or bytes; a same-client user asking for a case or asset outside their grants gets 404.

## Sub-features

- `wrong-client-page`: `/cases` for a client B session renders the 401 denial `[data-denial-code=wrong-client][data-status=401]`, no signed-in state, no case.
- `wrong-client-asset`: client A's original answers 401 to a client B session, with no PDF bytes and no download.
- `wrong-case-asset`: a client A viewer asking for B's asset id under their own case gets 404.
- `denial-audit`: every denial is a `denied` row in local D1; *covered by `test:hosted`'s `denials` leg*.

## How to get to it (user POV)

- Sign in with an identity of another client, or follow a link to another client's case or file.

## Driving it with verify-clearcase-hosted

Preconditions:

- `original-open` passed in the first browser context (signed in as `client-a/a-viewer`).

- **Deny.** In a second, fresh browser context, sign in as `client-b/b-editor` through the same `#test-identity` and `#sign-in` controls. Step `wrong-client`. `/cases` shows `[data-denial-code=wrong-client]` with status 401 and no case; an in-page GET of `/cases/case-a1/originals/a1-letter` answers 401 with no PDF and no synthetic label; navigating to that URL answers 401 with an HTML page titled "This session belongs to another client…" and starts no download; back in the first context, `/cases/case-a1/originals/b1-letter` answers 404.
- **Proof.** The screenshots `sign-in-form-b-editor`, `wrong-client-denied` and `wrong-client-original`.

## Gotchas

- Client B's identities are on client A's sign-in page only because the identity double lists every fixture identity; the deployment still refuses them.
- Wrong-client is 401 (the session is not valid for this deployment), wrong-case is 404 (nothing to reveal); neither is 403.
- An endpoint's refusal (the original's URL) renders Kit's static error page, which has no `[data-denial-code]`; the step reads the status from the navigation timing (`responseStatus`) and the page title instead.
