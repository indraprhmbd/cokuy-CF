<script lang="ts">
	import type { Component } from 'svelte';
	import Card from './Card.svelte';

	let {
		title,
		value,
		sub = '',
		icon: Icon
	}: {
		title: string;
		value: string;
		sub?: string;
		icon: Component;
	} = $props();
</script>

<Card class="flex items-start justify-between gap-3">
	<div>
		<p class="text-xs font-medium tracking-wide text-subtle uppercase">{title}</p>
		<p class="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
		{#if sub}
			<p class="mt-1 text-xs text-subtle">{sub}</p>
		{/if}
	</div>
	<span class="rounded-md bg-raised p-2 text-accent">
		<svelte:component this={Icon} size={18} />
	</span>
</Card>
