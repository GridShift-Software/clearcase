import type { HandleClientError } from '@sveltejs/kit/hooks';

// Kit 3 hands a failed enhanced-form fetch (the server unreachable mid-save) to handleError, whose default logs it to the
// console; Kit 2 passed it to the form's callback silently, and each view shows its own save-failed state. That network
// failure is expected, so it alone goes unlogged. App and framework errors are HTTP answers the page renders.
const NETWORK = new Set(['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']);
export const handleError: HandleClientError = ({ kind, error }) => {
	if (kind === 'unknown' && !(error instanceof TypeError && NETWORK.has(error.message))) console.error(error);
};
