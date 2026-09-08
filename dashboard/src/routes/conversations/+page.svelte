<script lang="ts">
	import type { PageData } from './$types';
	import Card from '$lib/components/Card.svelte';

	let { data }: { data: PageData } = $props();
</script>

<h1 class="mb-4 text-xl font-semibold tracking-tight">Conversations</h1>

<Card class="overflow-x-auto p-0">
	<table class="w-full text-sm">
		<thead>
			<tr class="border-b border-line text-left text-xs text-subtle uppercase">
				<th class="px-4 py-2 font-medium">Chat</th>
				<th class="px-4 py-2 font-medium">Messages</th>
				<th class="px-4 py-2 font-medium">Last activity</th>
			</tr>
		</thead>
		<tbody>
			{#each data.metrics.conversations as c (c.chat_id)}
				<tr class="border-b border-line last:border-0 hover:bg-raised">
					<td class="px-4 py-2 font-mono tabular-nums">{c.chat_id}</td>
					<td class="px-4 py-2 tabular-nums">{c.messages}</td>
					<td class="px-4 py-2 text-subtle tabular-nums">
						{c.last_activity.replace('T', ' ').slice(0, 19)}
					</td>
				</tr>
			{:else}
				<tr>
					<td class="px-4 py-6 text-center text-subtle" colspan="3">No conversations yet</td>
				</tr>
			{/each}
		</tbody>
	</table>
</Card>
