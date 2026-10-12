// The add form of a litigation register and its rows' Deletes (GRS-18 r2): per-request state, so no answer ever
// replaces or clears input it was not sent for.
// - An Add snapshots what it sends. While it is in flight the form is aria-busy, a status says so, and a second Add is
//   ignored (Add is disabled); the fields stay editable. On success only the fields that still hold what was sent are
//   cleared, so text typed in flight stays. A refusal or a lost request keeps the entry with its own error, a Retry
//   where one can succeed, and Discard, until an Add succeeds, is retried or the user discards it.
// - A Delete has its own state per row (in flight, error); it never touches the add form's entry or error.
// - Without JavaScript the row Deletes submit the add form (formaction), so the entry travels with them and the
//   server's answer re-fills it; `fromAnswer` reads that answer.
import { applyAction } from '$app/forms';
import { invalidateAll } from '$app/navigation';
import type { SubmitFunction } from '@sveltejs/kit';
import { lostMessage, refused, type Failure } from './submit.ts';

/** The note on an entry that came back with another action's answer without JavaScript. */
export const UNSAVED = 'Not saved yet: this entry is still only in the form. Press Add to save it, or Discard it.';

/** A server answer (`form`) as the page sees it without JavaScript. */
export type Answer = { op?: 'add' | 'delete'; values?: Record<string, string>; message?: string | null; retry?: boolean; target?: string; gone?: boolean; deleted?: string } | null | undefined;

export class EntryForm {
	values = $state<Record<string, string>>({});
	adding = $state(false);
	addError = $state<Failure | null>(null);
	/** an entry carried back through a Delete without JavaScript: not saved yet */
	note = $state<string | null>(null);
	/** rows (by Delete target id) whose Delete is in flight, and each row's Delete error */
	deleting = $state<Record<string, true>>({});
	deleteErrors = $state<Record<string, string>>({});
	/** a Delete that found its row already gone (said once, at the table) */
	notice = $state<string | null>(null);

	readonly #fields: readonly string[];
	readonly #canAdd: (v: Record<string, string>) => boolean;

	constructor(fields: readonly string[], canAdd: (v: Record<string, string>) => boolean, answer: Answer) {
		this.#fields = fields;
		this.#canAdd = canAdd;
		this.values = Object.fromEntries(fields.map((k) => [k, answer?.values?.[k] ?? '']));
		if (answer?.op === 'add' && answer.message) this.addError = { message: answer.message, retry: answer.retry === true };
		if (answer?.op === 'delete') {
			if (fields.some((k) => answer.values?.[k])) this.note = UNSAVED;
			if (answer.gone && answer.message) this.notice = answer.message;
			else if (answer.message && answer.target) this.deleteErrors = { [answer.target]: answer.message };
		}
	}

	/** Whether the form holds an entry that is not saved (typed, refused, or in flight). */
	get unsaved() { return this.adding || this.addError !== null || this.#fields.some((k) => this.values[k]); }

	/** Drop the entry on purpose (Discard). */
	discard = () => {
		if (this.adding) return;
		this.values = Object.fromEntries(this.#fields.map((k) => [k, '']));
		this.addError = null;
		this.note = null;
	};
	dismissDelete = (id: string) => { delete this.deleteErrors[id]; };

	submit: SubmitFunction = ({ action, formData, cancel }) => {
		if (action.search.includes('/delete')) return this.#remove(formData, cancel);
		if (this.adding) { cancel(); return; }
		const sent = Object.fromEntries(this.#fields.map((k) => [k, String(formData.get(k) ?? '')]));
		// v5 ignores an Add with nothing to add, silently, and so does this form (no request, nothing changes)
		if (!this.#canAdd(sent)) { cancel(); return; }
		this.adding = true;
		this.addError = null;
		this.note = null;
		return async ({ result }) => {
			try {
				if (result.type === 'success') {
					await invalidateAll();
					// only what still holds the submitted text is cleared: anything typed since stays
					for (const k of this.#fields) if (this.values[k] === sent[k]) this.values[k] = '';
				} else if (result.type === 'failure') {
					if (result.data?.message) this.addError = refused(result.data, 'Not saved.');
				} else if (result.type === 'redirect') await applyAction(result);
				else this.addError = lostMessage('add', result.status);
			} finally {
				this.adding = false;
			}
		};
	};

	#remove(formData: FormData, cancel: () => void) {
		const raw = String(formData.get('rowId') ?? formData.get('seedId') ?? '');
		const id = raw.slice(0, raw.lastIndexOf(' ') < 0 ? raw.length : raw.lastIndexOf(' '));
		if (!id || this.deleting[id]) { cancel(); return; }
		// with JavaScript the entry stays in the page; it is not sent with the Delete
		for (const k of this.#fields) formData.delete(k);
		this.deleting[id] = true;
		delete this.deleteErrors[id];
		this.notice = null;
		return async ({ result }: { result: import('@sveltejs/kit').ActionResult }) => {
			try {
				if (result.type === 'success') {
					if (result.data?.gone && typeof result.data.message === 'string') this.notice = result.data.message;
					await invalidateAll();
				} else if (result.type === 'failure') {
					this.deleteErrors[id] = refused(result.data, 'Not deleted.').message;
					// changed elsewhere: the list shows the entry as it is now
					if (result.status === 409 || result.status === 404) await invalidateAll();
				} else if (result.type === 'redirect') await applyAction(result);
				else this.deleteErrors[id] = lostMessage('delete', result.status).message;
			} finally {
				delete this.deleting[id];
			}
		};
	}
}
