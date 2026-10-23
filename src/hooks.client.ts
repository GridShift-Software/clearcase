import type { HandleClientError } from '@sveltejs/kit/hooks';
import { reloadFailed } from '$lib/components/reload.svelte';

// Kit 3 hands a failed enhanced-form fetch (the server unreachable mid-save) to handleError, whose default logs it to the
// console; Kit 2 passed it to the form's callback silently, and each view shows its own save-failed state. That network
// failure is expected, so it alone goes unlogged. App and framework errors are HTTP answers the page renders.
const NETWORK = new Set(['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']);
// The same failure, seen while the page reloads its data (a pending save's reload, GRS-160), ends the wait for that reload.
export const handleError: HandleClientError = ({ kind, error, event }) => {
	if (kind !== 'unknown') return;
	if (error instanceof TypeError && NETWORK.has(error.message)) reloadFailed(event.url);
	else console.error(error);
};
