import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupRun } from './cleanup.mjs';

test('cleanup continues after invitation deletion, session listing and user deletion failures', async () => {
	const actions = [];
	let userLists = 0, invitationLists = 0;
	const backend = {
		invitations: async () => ++invitationLists === 1 ? [{ id: 'inv_1' }, { id: 'inv_2' }] : [{ id: 'inv_1' }],
		call: async (_, p) => { actions.push(p); if (p.endsWith('inv_1')) throw new Error('temporary failure'); },
		users: async () => ++userLists === 1 ? [{ id: 'user_1' }, { id: 'user_2' }] : [{ id: 'user_1' }],
		sessions: async (id) => { actions.push(`sessions:${id}`); if (id === 'user_1') throw new Error('temporary failure'); return []; },
		deleteUser: async (id) => { actions.push(`delete:${id}`); if (id === 'user_1') throw new Error('temporary failure'); },
	};
	const counts = { usersDeleted: 0, invitationsDeleted: 0, sessionsEnded: 0, remaining: 0 };
	assert.equal(await cleanupRun({ backends: { staff: backend }, prefix: 'cc201-test-', sessions: [], owned: { users: [], invitations: [] }, worlds: {}, counts }), false);
	assert.ok(actions.includes('/invitations/inv_2'));
	assert.ok(actions.includes('delete:user_1')); // still attempted when its sessions could not be enumerated
	assert.ok(actions.includes('delete:user_2'));
	assert.equal(counts.usersDeleted, 1);
	assert.equal(counts.invitationsDeleted, 1);
});
test('cleanup uses known IDs after listing failure and revokes a surviving active session', async () => {
	const deleted = [], revoked = [];
	const backend = {
		invitations: async () => { throw new Error('listing failed'); }, users: async () => { throw new Error('listing failed'); },
		call: async (_, p) => deleted.push(p), sessions: async () => [], deleteUser: async (id) => deleted.push(id),
		getSession: async () => ({ status: revoked.length ? 'revoked' : 'active' }), revokeSession: async (id) => revoked.push(id),
	};
	const counts = { usersDeleted: 0, invitationsDeleted: 0, sessionsEnded: 0, remaining: 0 };
	const okay = await cleanupRun({ backends: { a: backend }, prefix: 'cc201-test-', sessions: [{ instance: 'a', id: 'sess_1' }], owned: { users: [{ instance: 'a', id: 'user_1' }], invitations: [{ instance: 'a', id: 'inv_1' }] }, worlds: {}, counts });
	assert.equal(okay, false);
	assert.deepEqual(deleted, ['/invitations/inv_1', 'user_1']);
	assert.deepEqual(revoked, ['sess_1']);
	assert.equal(counts.sessionsEnded, 1);
});
