<script>
	let { data } = $props();
</script>

<h1>Sign in</h1>
<p data-entry="login" data-reason={data.reason} data-copy="placeholder-for-review">{data.guidance}</p>
<p data-next={data.next}>After signing in you return to {data.next}.</p>
