// Case text as the pages show it: invisible and control characters made visible (bidi overrides cannot reorder a
// filename), long names clipped. Svelte's text interpolation escapes markup; no page renders dataset text as HTML.
export { displayFilename, revealInvisible } from '../../case-package/render.ts';
