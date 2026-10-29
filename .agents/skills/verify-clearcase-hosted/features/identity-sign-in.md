# Identity: sign in

A client user signs in to their deployment and lands on their case list. In the hosted-gate artifact the identity provider is a named test double: the sign-in page offers the synthetic fixture identities, and choosing one starts a session kept in local D1 behind an HttpOnly, SameSite=Lax `clearcase_session` cookie. Clerk replaces the double under GRS-113, and no run of this skill is Clerk evidence.

## Sub-features

- `sign-in-form` lists the fixture identities of every client in `#test-identity`, under the notice `[data-auth-provider=double]`.
- `sign-in` posts the form; the action answers 303 to `/cases` with the session cookie.
- `signed-in` shows `[data-auth-state=signed-in]` with the subject and the `#sign-out` form.
- `sign-out` ends the session at once; *covered by `test:hosted`'s `sign-out` leg, not driven here*.

## How to get to it (user POV)

- Open the deployment's root `/`: without a session it redirects to `/sign-in`.
- A 401 page's `#sign-in-link`.

## Driving it with verify-clearcase-hosted

Preconditions:

- A fresh browser context with no cookie for the app origin.

- **Sign in.** Navigate to `/`, wait for `/sign-in` with `[data-auth-provider=double]`, choose `client-a/a-viewer` in `#test-identity`, click `#sign-in`. Step `sign-in`. `/cases` shows `[data-auth-state=signed-in]` with no "Signed in as" line and no subject (the double carries no name; a real session shows its name claim, never the Clerk ID), CDP's cookie jar holds `clearcase_session` with `httpOnly` and `SameSite=Lax`, and `document.cookie` does not show it.
- **Proof.** The screenshots `sign-in-form-a-viewer` and `signed-in-cases`.

## Gotchas

- The identity is a test double (`identityProvider: test-identity-double` on `/health`). The summary names it a double; a pass says nothing about Clerk.
- The form is a plain POST, so it works before hydration; the Origin check refuses a cross-origin POST with 403 (`test:hosted`'s `request` leg).
