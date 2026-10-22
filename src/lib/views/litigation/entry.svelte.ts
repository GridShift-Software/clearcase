import { applyAction } from '$app/forms';
import { invalidateAll } from '$app/navigation';
import type { SubmitFunction } from '$app/forms';
import { deleteStep } from '$lib/components/confirm-delete';
import { lostMessage, refused, type Failure } from './submit.ts';

export const UNSAVED = 'Not saved yet: this entry is still only in the form. Press Add to save it, or Discard it.';

export type Answer = { op?: 'add' | 'delete'; values?: Record<string, string>; message?: string | null; retry?: boolean; target?: string; gone?: boolean; deleted?: string; confirm?: string | null } | null | undefined;

export class EntryForm {
	values = $state<Record<string, string>>({});
	adding = $state(false);
	addError = $state<Failure | null>(null);
	note = $state<string | null>(null);
	deleting = $state<Record<string, true>>({});
	deleteErrors = $state<Record<string, string>>({});
	notice = $state<string | null>(null);
	/** The Delete value awaiting Confirm; without JavaScript the server's refusal names it. */
	confirming = $state<string | null>(null);

	readonly #fields: readonly string[];
	readonly #canAdd: (v: Record<string, string>) => boolean;

	constructor(fields: readonly string[], canAdd: (v: Record<string, string>) => boolean, answer: Answer) {
		this.#fields = fields;
		this.#canAdd = canAdd;
		this.values = Object.fromEntries(fields.map((k) => [k, answer?.values?.[k] ?? '']));
		if (answer?.op === 'add' && answer.message) this.addError = { message: answer.message, retry: answer.retry === true };
		if (answer?.op === 'delete') {
			if (fields.some((k) => answer.values?.[k])) this.note = UNSAVED;
			this.confirming = answer.confirm ?? null;
			if (answer.gone && answer.message) this.notice = answer.message;
			else if (answer.message && answer.target) this.deleteErrors = { [answer.target]: answer.message };
		}
	}

	get unsaved() { return this.adding || this.addError !== null || this.#fields.some((k) => this.values[k]); }

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
		if (!this.#canAdd(sent)) { cancel(); return; }
		this.adding = true;
		this.addError = null;
		this.note = null;
		return async ({ result }) => {
			try {
				if (result.type === 'success') {
					await invalidateAll();
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
		const step = deleteStep(formData, raw);
		this.confirming = step === 'ask' ? raw : null;
		if (step !== 'confirm') { cancel(); return; }
		for (const k of this.#fields) formData.delete(k);
		this.deleting[id] = true;
		delete this.deleteErrors[id];
		this.notice = null;
		return async ({ result }: { result: import('$app/forms').ActionResult }) => {
			try {
				if (result.type === 'success') {
					if (result.data?.gone && typeof result.data.message === 'string') this.notice = result.data.message;
					await invalidateAll();
				} else if (result.type === 'failure') {
					this.deleteErrors[id] = refused(result.data, 'Not deleted.').message;
					if (result.status === 409 || result.status === 404) await invalidateAll();
				} else if (result.type === 'redirect') await applyAction(result);
				else this.deleteErrors[id] = lostMessage('delete', result.status).message;
			} finally {
				delete this.deleting[id];
			}
		};
	}
}
