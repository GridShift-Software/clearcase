import type { Actions, RequestEvent } from '@sveltejs/kit';
import { addNote, deleteNote, loadNotes } from '$lib/views/hosted/notes.server';

// The user's notes on one case, independent of published results: they load and save while results are pending,
// withdrawn or unavailable. Every read and write goes through the request's AsyncUserWork after the authorized case read.
export const load = async ({ locals, params, url }: RequestEvent) => ({
	...(await loadNotes(locals, (params as Record<string, string | undefined>).caseId)),
	saved: url.searchParams.has('saved'),
	deleted: url.searchParams.has('deleted'),
});

export const actions: Actions = { add: addNote, delete: deleteNote };
