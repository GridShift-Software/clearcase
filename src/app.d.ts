declare global {
	namespace App {
		interface PageState {
			/** chronology filters (URL search string) of a shallow-routed history entry */
			chronology?: string;
		}
	}
}
export {};
