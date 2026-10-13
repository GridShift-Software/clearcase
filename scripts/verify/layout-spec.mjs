// What scripts/verify/layout.mjs measures, shared with scripts/verify/matrix.mjs so that the matrix can tell a complete
// layout run from a partial one: the viewport widths of every view, and the shared components checked in their states.
export const WIDTHS = [320, 390, 768, 1280];
export const COMPONENTS = [
	['navigation link', 'overview', 'nav a[data-view]:not([aria-current])'],
	['current navigation link', 'overview', 'nav a[aria-current="page"]'],
	['skip link', 'overview', 'a[href="#main"]'],
	['link in main', 'chronology', 'main#main a[href]'],
	['button', 'deadlines_tab', 'main#main button'],
	['text input', 'deadlines_tab', 'main#main input[type=text], main#main input:not([type])'],
	['select', 'deadlines_tab', 'main#main select'],
	['table header', 'documents', 'main#main th, main#main [role=columnheader]'],
];
