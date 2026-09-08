<script lang="ts">
	import type { PageData } from './$types';
	import AreaChart from '$lib/components/AreaChart.svelte';
	import BarChart from '$lib/components/BarChart.svelte';
	import Card from '$lib/components/Card.svelte';
	import StatCard from '$lib/components/StatCard.svelte';
	import { compact, usd } from '$lib/format';

	let { data }: { data: PageData } = $props();
	const m = $derived(data.metrics);
	const tokens = $derived(m.daily.map((d) => ({ label: d.day.slice(5), value: d.total_tokens })));
	const spend = $derived(m.daily.map((d) => ({ label: d.day.slice(5), value: d.cost_usd })));
	const today = $derived(m.daily[m.daily.length - 1]);
	const avgPerDay = $derived(m.daily.length ? m.totals.cost_usd / m.daily.length : 0);
	const inPct = $derived(
		m.totals.total_tokens ? Math.round((m.totals.prompt_tokens / m.totals.total_tokens) * 100) : 0
	);
	const rate = $derived(
		`$${m.pricing.price_in_per_m} in / $${m.pricing.price_out_per_m} out per 1M`
	);
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
	<StatCard title="Spend total" value={usd(m.totals.cost_usd)} sub={rate} />
	<StatCard
		title="Spend today"
		value={usd(today ? today.cost_usd : 0)}
		sub="{usd(avgPerDay)} avg per active day"
	/>
	<StatCard
		title="Tokens in"
		value={compact(m.totals.prompt_tokens)}
		sub="{inPct}% of {compact(m.totals.total_tokens)} total"
	/>
	<StatCard
		title="Tokens out"
		value={compact(m.totals.completion_tokens)}
		sub="{100 - inPct}% of {compact(m.totals.total_tokens)} total"
	/>
	<StatCard
		title="Turns"
		value={compact(m.totals.turns)}
		sub="{m.totals.errors} failed · {m.conversations.length} chats"
	/>
</div>

<div class="mt-3 grid gap-3 lg:grid-cols-2">
	<Card>
		<h2 class="mb-2 text-sm font-medium">Tokens per day</h2>
		<AreaChart data={tokens} />
	</Card>
	<Card>
		<h2 class="mb-2 text-sm font-medium">Spend per day</h2>
		<BarChart data={spend} format={usd} />
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
