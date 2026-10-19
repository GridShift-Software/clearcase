import type { RequestServices } from './lib/server/runtime/contracts.ts';
declare global {
	namespace App {
		interface Locals extends RequestServices {}
		interface Error {
			message: string;
			/** The contract refusal code behind a hosted error page, e.g. wrong-client. */
			code?: string;
		}
		interface PageState {
			chronology?: string;
		}
	}
}
export {};
