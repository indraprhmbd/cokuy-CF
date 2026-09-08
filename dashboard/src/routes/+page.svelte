<script lang="ts">
	import type { PageData } from './$types';
	import { ChatBubble, Coins, Flash, MessageText, WarningTriangle } from '@indaco/svelte-iconoir';
	import AreaChart from '$lib/components/AreaChart.svelte';
	import BarChart from '$lib/components/BarChart.svelte';
	import Card from '$lib/components/Card.svelte';
	import StatCard from '$lib/components/StatCard.svelte';
	import { compact, estCost } from '$lib/format';

	let { data }: { data: PageData } = $props();
	const m = $derived(data.metrics);
	const tokens = $derived(m.daily.map((d) => ({ label: d.day.slice(5), value: d.total_tokens })));
	const turns = $derived(m.daily.map((d) => ({ label: d.day.slice(5), value: d.turns })));
</script>

<div class="mb-4 flex items-center justify-between">
	<h1 class="text-xl font-semibold tracking-tight">Overview</h1>
	<div class="flex gap-2 text-sm">
		{#each [7, 30, 90] as d (d)}
			<a
				href="/?days={d}"
				class="rounded-md border border-line px-2 py-1 {data.days === d
					? 'bg-chrome font-medium'
					: 'text-subtle hover:text-ink'}"
			>
				{d}d
			</a>
		{/each}
	</div>
</div>

<div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
	<StatCard title="Turns" value={compact(m.totals.turns)} icon={ChatBubble} />
	<StatCard
		title="Tokens"
		value={compact(m.totals.total_tokens)}
		sub={estCost(m.totals.prompt_tokens, m.totals.completion_tokens) + ' est at promo rate'}
		icon={Coins}
	/>
	<StatCard title="Failed turns" value={String(m.totals.errors)} icon={WarningTriangle} />
	<StatCard title="Active days" value={String(m.daily.length)} sub="last {data.days} days" icon={Flash} />
	<StatCard
		title="Chats"
		value={String(m.conversations.length)}
		sub={compact(m.conversations.reduce((a, c) => a + c.messages, 0)) + ' messages'}
		icon={MessageText}
	/>
</div>

<div class="mt-3 grid gap-3 lg:grid-cols-2">
	<Card>
		<h2 class="mb-2 text-sm font-medium">Tokens per day</h2>
		<AreaChart data={tokens} />
	</Card>
	<Card>
		<h2 class="mb-2 text-sm font-medium">Turns per day</h2>
		<BarChart data={turns} />
	</Card>
</div>

<Card class="mt-3">
	<h2 class="mb-2 text-sm font-medium">Latest failures</h2>
	{#if !m.recent_errors.length}
		<p class="text-sm text-subtle">None in range. All turns succeeded.</p>
	{:else}
		<ul class="flex flex-col gap-2">
			{#each m.recent_errors.slice(0, 5) as e (e.update_id)}
				<li class="rounded-md bg-raised px-3 py-2 text-sm">
					<span class="font-medium tabular-nums">#{e.update_id}</span>
					<span class="text-subtle"> {e.created_at.replace('T', ' ').slice(0, 19)} </span>
					<p class="mt-0.5 text-danger">{e.error}</p>
				</li>
			{/each}
		</ul>
	{/if}
</Card>
