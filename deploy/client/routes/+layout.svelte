<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
</script>

<header class="hosted"><a href="/cases">ClearCase</a></header>
<main id="main" data-ready="true">{@render children()}</main>

<style>
	:global {
/* Montserrat 5.2.8, latin subsets, from @fontsource/montserrat on npm.
   SIL Open Font License: /fonts/montserrat-OFL.txt. */
@font-face { font-family: Montserrat; src: url('/fonts/montserrat-latin-400-normal.woff2') format('woff2'); font-style: normal; font-weight: 400; font-display: swap; }
@font-face { font-family: Montserrat; src: url('/fonts/montserrat-latin-500-normal.woff2') format('woff2'); font-style: normal; font-weight: 500; font-display: swap; }
@font-face { font-family: Montserrat; src: url('/fonts/montserrat-latin-600-normal.woff2') format('woff2'); font-style: normal; font-weight: 600; font-display: swap; }

:root {
  --navy: #162436; --navy-hover: #0F1A28;
  --navy-10: #E8E9EB; --navy-20: #D0D3D7; --navy-40: #A2A7AF; --navy-60: #737B87; --navy-80: #454F5E;
  --teal: #14B8A2; --teal-hover: #0FA08D;
  --teal-10: #E8F8F6; --teal-20: #D0F1EC; --teal-40: #A1E3DA; --teal-60: #72D4C7; --teal-80: #43C6B5;
  --canvas: #F7F8FA; --subtle: #F1F3F5; --surface: #FFFFFF;
  --border: #E4E7EB; --border-strong: #CBD2D9; --border-control: var(--navy-60);
  --focus-ring: var(--teal-hover);
  --text: #162436; --text-secondary: #52606D; --text-tertiary: #7B8794;
  --danger: #B91C1C; --info: #1D4ED8; --success: #047857; --warning: #B45309;
  --danger-tint: #FEF2F2; --info-tint: #EFF6FF; --success-tint: #ECFDF5; --warning-tint: #FFFBEB;
  --radius: 6px; --shadow: 0 1px 2px rgba(15, 23, 42, .04), 0 1px 3px rgba(15, 23, 42, .06);
  --sidebar: 240px; --topbar: 56px;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--canvas); color: var(--text); font: 400 16px/1.5 Montserrat, sans-serif; }
h1, h2, h3, h4, h5, h6 { color: var(--navy); font-weight: 600; line-height: 1.25; }
label, th { font-weight: 500; }
a { color: var(--navy); }
a:hover { color: var(--navy-hover); }
:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 2px; }
button, input, select, textarea { font: inherit; color: inherit; }
button, input[type='submit'] { background: var(--navy); color: var(--surface); border: 1px solid var(--navy); border-radius: var(--radius); padding: .6rem 1rem; font-weight: 600; cursor: pointer; }
button:hover, input[type='submit']:hover { background: var(--navy-hover); }
button:disabled, input:disabled { cursor: not-allowed; opacity: .65; }
input:not([type='checkbox']):not([type='radio']):not([type='submit']), select, textarea { background: var(--surface); border: 1px solid var(--border-control); border-radius: var(--radius); padding: .5rem; max-width: 100%; }
fieldset { border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow); }
legend { font-weight: 600; }
table { border-collapse: collapse; background: var(--surface); max-width: 100%; }
th { background: var(--subtle); }
th, td { border-bottom: 1px solid var(--border); padding: .5rem; text-align: left; vertical-align: top; }
code, pre { font-family: ui-monospace, monospace; }

	}
	.hosted { min-height: var(--topbar); display: flex; align-items: center; padding: 0 1.5rem; background: var(--navy); font-weight: 600; }
	.hosted a { color: var(--surface); }
	main { padding: 1.5rem; max-width: 80rem; margin: 0 auto; }
</style>
