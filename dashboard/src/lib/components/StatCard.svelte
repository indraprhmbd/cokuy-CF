<script lang="ts">
	import type { IconData } from '$lib/types';
	import Icon from './Icon.svelte';
	import Card from './Card.svelte';

	let {
		title,
		value,
		sub = '',
		icon
	}: {
		title: string;
		value: string;
		sub?: string;
		icon: IconData;
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
		<Icon data={icon} size={18} />
	</span>
</Card>
