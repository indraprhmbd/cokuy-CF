<script lang="ts">
	import { page } from '$app/state';
</script>

<div class="mx-auto max-w-md py-16 text-center">
	<h1 class="text-xl font-semibold">Dashboard failed to load</h1>
	<p class="mt-2 text-sm text-subtle">
		{page.error?.message || 'Unknown error.'} Is the bot running with METRICS_TOKEN set?
	</p>
	<a href="/" class="mt-4 inline-block rounded-md border border-line px-3 py-1.5 text-sm">
		Retry
	</a>
</div>
