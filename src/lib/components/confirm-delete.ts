// A destructive action runs only once it is confirmed (GRS-175): a register row's Delete, and Restore or Clear of the
// Court Bundle header. The request carries the target it was confirmed for in its `confirm` field, so a server action
// refuses a delete that arrives without it. ConfirmDelete.svelte asks inline; without JavaScript the server's refusal
// asks, and its Cancel posts `cancel`.

/** The field naming the target a request was confirmed for. */
export const CONFIRM = 'confirm';
/** The field a Cancel posts without JavaScript, so the server returns the page's draft and deletes nothing. */
export const CANCEL = 'cancel';

export type DeleteStep = 'ask' | 'cancel' | 'confirm';

/** Where a delete request for `target` stands: cancelled, confirmed for exactly that target, or still to be asked. */
export const deleteStep = (f: FormData, target: string): DeleteStep =>
	f.has(CANCEL) ? 'cancel' : target !== '' && f.get(CONFIRM) === target ? 'confirm' : 'ask';
