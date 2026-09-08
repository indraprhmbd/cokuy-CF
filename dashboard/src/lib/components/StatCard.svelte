<script lang="ts">
	import Card from './Card.svelte';

	let { title, value, sub = '' }: { title: string; value: string; sub?: string } = $props();
</script>

<Card>
	<p class="text-xs font-medium tracking-wide text-subtle uppercase">{title}</p>
	<p class="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
	{#if sub}
		<p class="mt-1 text-xs text-subtle">{sub}</p>
	{/if}
</Card>
