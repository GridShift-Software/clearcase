<script lang="ts">
	// A page under the hosted case layout's write access, as the layout sets it: a viewer's (false) or an editor's (true).
	import type { Component } from 'svelte';
	import { setHostedWriteAccess } from '../../../src/lib/components/write-access';
	let { canWrite, page: Page, props }: { canWrite: boolean; page: Component<any>; props: Record<string, unknown> } = $props();
	setHostedWriteAccess(() => canWrite);
</script>

<Page {...props} />
