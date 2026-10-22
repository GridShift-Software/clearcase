<script lang="ts">
	// An inline two-step destructive control (GRS-175): Delete hides itself and shows the question with Confirm and Cancel,
	// and only Confirm acts. The page keeps the one target awaiting confirmation in `pending`. Inside a form, Confirm
	// submits with the target in the `confirm` field; with `onconfirm`, Confirm calls it instead. Confirm unmounts when
	// pressed, so focus returns to this control once a failed action leaves it enabled again, and to the page heading
	// when the control itself goes (its row was deleted). A failed action's message belongs in the control's
	// aria-describedby, so it is read again when focus returns. All three buttons skip the browser's validation of the form
	// they submit: that form also holds the page's Add input, and half of a date typed there must not stop a delete.
	import { onMount, tick } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import { CANCEL, CONFIRM } from './confirm-delete';

	type Props = Omit<HTMLButtonAttributes, 'value' | 'onclick' | 'onkeydown' | 'type' | 'hidden'> & {
		pending: string | null;
		target: string;
		question: string;
		label?: string;
		confirmLabel?: string;
		onconfirm?: () => void;
	};
	let { pending = $bindable(), target, question, label = 'Delete', confirmLabel = 'Confirm delete', onconfirm, disabled, form, formaction, name, class: cls, ...rest }: Props = $props();
	const asking = $derived(pending === target);
	const type = $derived(onconfirm ? 'button' : 'submit');
	const value = $derived(name ? target : undefined);
	let opener = $state<HTMLButtonElement>();
	// Confirm was pressed and its action has not settled: focus follows the action
	let settling = $state(false);
	const lost = () => !document.activeElement || document.activeElement === document.body;

	// without JavaScript these buttons submit: the server asks, or returns the draft on Cancel
	function ask(e: MouseEvent) {
		e.preventDefault();
		pending = target;
	}
	async function cancel(e?: Event) {
		e?.preventDefault();
		pending = null;
		await tick();
		opener?.focus();
	}
	function pressed() {
		settling = true;
	}
	function confirm() {
		pressed();
		pending = null;
		onconfirm?.();
	}
	// the action ran and left the control enabled: it failed, or it only replaced content
	$effect(() => {
		if (!settling || asking || disabled) return;
		settling = false;
		void tick().then(() => { if (lost()) opener?.focus(); });
	});
	// the control went before its action settled: its row was deleted
	onMount(() => () => {
		if (settling) setTimeout(() => { if (lost()) document.querySelector<HTMLElement>('[data-page-heading]')?.focus(); });
	});
	// a held key repeats keydown while focus moves from Delete to Confirm, or from Cancel back to Delete: no repeat
	// presses any of the three, so one key press asks, confirms or cancels once
	function held(e: KeyboardEvent) {
		if (e.repeat) e.preventDefault();
		return e.repeat;
	}
	function keys(e: KeyboardEvent) {
		if (held(e) || e.key !== 'Escape') return;
		e.preventDefault();
		void cancel();
	}
</script>

<button bind:this={opener} class={['opener', cls]} hidden={asking} {type} {form} {formaction} {name} {value} {disabled} formnovalidate {...rest} onclick={ask} onkeydown={held}>{label}</button>
{#if asking}
	<!-- Without JavaScript the server's answer renders the question, and the browser's autofocus focuses the question, not
	     Confirm: the repeats of the key that pressed Delete still arrive once that page loads, and nothing can tell them
	     from a new press there. Tab reaches Confirm. With JavaScript the attach focuses Confirm, which ignores repeats. -->
	<!-- svelte-ignore a11y_autofocus -->
	<span class="confirm" role="group" aria-label={question} data-confirming={target} tabindex="-1" autofocus>
		<span class="question">{question}</span>
		{#if !onconfirm}<input type="hidden" {form} name={CONFIRM} value={target} />{/if}
		<button {type} class="danger" {form} {formaction} {name} {value} {disabled} formnovalidate data-delete-confirm onclick={onconfirm ? confirm : pressed} onkeydown={keys} {@attach (el) => el.focus()}>{confirmLabel}</button>
		<button {type} {form} {formaction} formnovalidate name={onconfirm ? undefined : CANCEL} value={onconfirm ? undefined : target} data-delete-cancel onclick={cancel} onkeydown={keys}>Cancel</button>
	</span>
{/if}

<style>
	.opener[hidden] { display: none; }
	.confirm { display: inline-flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
	.question { font-weight: 600; }
</style>
