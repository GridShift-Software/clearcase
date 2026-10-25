import type { RequestEvent } from '@sveltejs/kit';
import { createNote, deleteNote, listNotes } from '$lib/viewer/hosted/notes-route';

// Page notes on one original, persisted through the user-work service (never in the browser). See $lib/viewer/hosted/page-notes.
export const GET = (e: RequestEvent) => listNotes(e);
export const POST = (e: RequestEvent) => createNote(e);
export const DELETE = (e: RequestEvent) => deleteNote(e);
