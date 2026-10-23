// Best-effort per-resource cleanup: one failed listing or deletion must not skip another identity.
export async function cleanupRun({ backends, prefix, sessions, owned, worlds, counts }) {
	let errors = 0;
	const attempt = async (fn) => { try { return await fn(); } catch { errors++; return undefined; } };
	for (const w of Object.values(worlds)) await attempt(() => w.stop());
	for (const [instance, backend] of Object.entries(backends)) {
		const invitations = new Set(owned.invitations.filter((i) => i.instance === instance).map((i) => i.id));
		for (const i of await attempt(() => backend.invitations(prefix)) ?? []) invitations.add(i.id);
		for (const id of invitations) await attempt(async () => {
			try { await backend.call('DELETE', `/invitations/${id}`); } catch (e) { if (e?.status !== 404) throw e; }
			counts.invitationsDeleted++;
		});
		const users = new Set(owned.users.filter((u) => u.instance === instance).map((u) => u.id));
		for (const u of await attempt(() => backend.users(prefix)) ?? []) users.add(u.id);
		for (const id of users) {
			for (const s of await attempt(() => backend.sessions(id)) ?? []) if (!sessions.some((x) => x.instance === instance && x.id === s.id)) sessions.push({ instance, id: s.id });
			await attempt(async () => {
				try { await backend.deleteUser(id); } catch (e) { if (e?.status !== 404) throw e; }
				counts.usersDeleted++;
			});
		}
		await attempt(async () => { counts.remaining += (await backend.users(prefix)).length; });
		await attempt(async () => { counts.remaining += (await backend.invitations(prefix)).length; });
	}
	for (const s of sessions) await attempt(async () => {
		const backend = backends[s.instance];
		const read = async () => { try { return (await backend.getSession(s.id)).status; } catch (e) { if (e?.status === 404) return 'gone'; throw e; } };
		let status = await read();
		if (status === 'active' || status === 'pending') { await backend.revokeSession(s.id); status = await read(); }
		if (!['ended', 'revoked', 'abandoned', 'expired', 'gone'].includes(status)) throw new Error('session not ended');
		counts.sessionsEnded++;
	});
	return errors === 0;
}
