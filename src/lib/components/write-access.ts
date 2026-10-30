// What a view may offer for the user's own work. The hosted case layout sets it: `canWrite` from the signed-in person's
// grant, so a viewer sees no Add, Edit, Delete, Save or Build control the server would refuse, and `hosted`, so the pages
// say the work is saved on the server. The local pilot never sets it, so its pages keep every control and their wording.
// Hiding a control is not authorization: every hosted write is authorized on the server.
import { getContext, setContext } from 'svelte';

const KEY = Symbol('write-access');
export interface WriteAccess { readonly canWrite: boolean; readonly hosted: boolean }
const LOCAL: WriteAccess = { canWrite: true, hosted: false };

/** Called once by the hosted layout; `canWrite` is read again on each access, so a changed grant shows on the next load. */
export function setHostedWriteAccess(canWrite: () => boolean): void {
	setContext<WriteAccess>(KEY, { get canWrite() { return canWrite(); }, hosted: true });
}

/** The access a view renders with: the hosted layout's, or the local pilot's full access where none was set. */
export function writeAccess(): WriteAccess {
	return getContext<WriteAccess | undefined>(KEY) ?? LOCAL;
}
