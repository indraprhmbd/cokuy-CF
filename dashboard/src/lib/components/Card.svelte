<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	let { children, class: cls = '' }: { children: Snippet; class?: string } = $props();
</script>

<section class={cn('rounded-lg border border-line bg-canvas p-4', cls)}>
	{@render children()}
</section>
