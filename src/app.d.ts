import type { RequestServices } from './lib/server/runtime/contracts.ts';
declare global {
	namespace App {
		interface Locals extends RequestServices {}
		interface PageState {
			chronology?: string;
		}
	}
}
export {};
