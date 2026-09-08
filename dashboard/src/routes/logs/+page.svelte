<script lang="ts">
	import type { PageData } from './$types';
	import Card from '$lib/components/Card.svelte';

	let { data }: { data: PageData } = $props();
	const m = $derived(data.metrics);
</script>

<h1 class="mb-4 text-xl font-semibold tracking-tight">Logs</h1>

<Card>
	<h2 class="mb-2 text-sm font-medium">Failed turns</h2>
	{#if !m.recent_errors.length}
		<p class="text-sm text-subtle">None in range. All turns succeeded.</p>
	{:else}
		<ul class="flex flex-col gap-2">
			{#each m.recent_errors as e (e.update_id)}
				<li class="rounded-md bg-raised px-3 py-2 text-sm">
					<span class="font-medium tabular-nums">#{e.update_id}</span>
					<span class="text-subtle">
						{e.created_at.replace('T', ' ').slice(0, 19)} ({e.model})
					</span>
					<p class="mt-0.5 text-danger">{e.error}</p>
				</li>
			{/each}
		</ul>
	{/if}
</Card>

<Card class="mt-3 overflow-x-auto p-0">
	<table class="w-full text-sm">
		<thead>
			<tr class="border-b border-line text-left text-xs text-subtle uppercase">
				<th class="px-4 py-2 font-medium">Day</th>
				<th class="px-4 py-2 font-medium">Turns</th>
				<th class="px-4 py-2 font-medium">Tokens</th>
				<th class="px-4 py-2 font-medium">Errors</th>
			</tr>
		</thead>
		<tbody>
			{#each [...m.daily].reverse() as d (d.day)}
				<tr class="border-b border-line last:border-0 hover:bg-raised">
					<td class="px-4 py-2 font-mono">{d.day}</td>
					<td class="px-4 py-2 tabular-nums">{d.turns}</td>
					<td class="px-4 py-2 tabular-nums">{d.total_tokens}</td>
					<td class="px-4 py-2 tabular-nums {d.errors ? 'text-danger' : ''}">{d.errors}</td>
				</tr>
			{:else}
				<tr>
					<td class="px-4 py-6 text-center text-subtle" colspan="4">No data in range</td>
				</tr>
			{/each}
		</tbody>
	</table>
</Card>
