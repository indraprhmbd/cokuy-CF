<script lang="ts">
	import type { IconData } from '$lib/types';

	let { data, size = 16 }: { data: IconData; size?: number } = $props();
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	width={size}
	height={size}
	stroke-width={1.5}
	viewBox="0 0 24 24"
	fill="none"
	color="currentColor"
	aria-label={data.name}
>
	{#each data.data as attr (attr.d)}
		<path {...attr} />
	{/each}
</svg>
