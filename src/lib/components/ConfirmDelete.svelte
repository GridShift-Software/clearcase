<script lang="ts">
	// An inline two-step destructive control (GRS-175): Delete hides itself and shows the question with Confirm and Cancel,
	// and only Confirm acts. The page keeps the one target awaiting confirmation in `pending`. Inside a form, Confirm
	// submits with the target in the `confirm` field; with `onconfirm`, Confirm calls it instead.
	import { tick } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import { CANCEL, CONFIRM } from './confirm-delete';

	type Props = Omit<HTMLButtonAttributes, 'value' | 'onclick' | 'type' | 'hidden'> & {
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
	function confirm() {
		pending = null;
		onconfirm?.();
	}
	// a held key repeats keydown: the repeats must not press Confirm (or Cancel, which would land on Delete and ask again)
	function keys(e: KeyboardEvent) {
		if (e.repeat) { e.preventDefault(); return; }
		if (e.key !== 'Escape') return;
		e.preventDefault();
		void cancel();
	}
</script>

<button bind:this={opener} class={['opener', cls]} hidden={asking} {type} {form} {formaction} {name} {value} {disabled} {...rest} onclick={ask}>{label}</button>
{#if asking}
	<span class="confirm" role="group" aria-label={question} data-confirming={target}>
		<span class="question">{question}</span>
		{#if !onconfirm}<input type="hidden" {form} name={CONFIRM} value={target} />{/if}
		<!-- svelte-ignore a11y_autofocus -->
		<button {type} class="danger" {form} {formaction} {name} {value} {disabled} autofocus data-delete-confirm onclick={onconfirm ? confirm : undefined} onkeydown={keys} {@attach (el) => el.focus()}>{confirmLabel}</button>
		<button {type} {form} {formaction} name={onconfirm ? undefined : CANCEL} value={onconfirm ? undefined : target} data-delete-cancel onclick={cancel} onkeydown={keys}>Cancel</button>
	</span>
{/if}

<style>
	.opener[hidden] { display: none; }
	.confirm { display: inline-flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
	.question { font-weight: 600; }
</style>
