/**
 * The name to show beside "Sign out", or null for none. The Clerk provider takes the session's `name` or `first_name`
 * claim and otherwise falls back to the subject (`user_…`), which is an identifier and never shown to a client.
 */
export function displayName(identity: { readonly name?: unknown; readonly principal: { readonly subject: string } | null }): string | null {
	const name = typeof identity.name === 'string' ? identity.name.trim() : '';
	if (!name || name === identity.principal?.subject || /^user_[A-Za-z0-9]+$/.test(name)) return null;
	return name;
}
