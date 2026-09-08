<script lang="ts">
	interface Point {
		label: string;
		value: number;
	}

	let { data, format = (v: number) => String(v) }: { data: Point[]; format?: (v: number) => string } =
		$props();

	const W = 600;
	const H = 200;
	const PAD = 6;

	const max = $derived(Math.max(1, ...data.map((d) => d.value)));
	const slot = $derived(data.length ? (W - PAD * 2) / data.length : 0);
	const barW = $derived(Math.max(2, Math.min(28, slot * 0.55)));
</script>

{#if !data.length}
	<p class="py-8 text-center text-sm text-subtle">No data in range</p>
{:else}
	<svg
		viewBox="0 0 {W} {H}"
		preserveAspectRatio="none"
		class="h-44 w-full"
		role="img"
		aria-label="Bar chart"
	>
		{#each data as d, i (d.label)}
			{@const h = (d.value / max) * (H - PAD * 2 - 20)}
			<rect
				x={PAD + i * slot + (slot - barW) / 2}
				y={H - PAD - h}
				width={barW}
				height={Math.max(h, d.value > 0 ? 2 : 0)}
				rx="2"
				fill="var(--color-accent)"
				opacity={d.value > 0 ? 0.85 : 0.2}
			>
				<title>{d.label}: {format(d.value)}</title>
			</rect>
		{/each}
		<line
			x1="0"
			y1={H - PAD}
			x2={W}
			y2={H - PAD}
			stroke="var(--color-line)"
			stroke-width="1"
			vector-effect="non-scaling-stroke"
		/>
	</svg>
	<div class="mt-1 flex justify-between text-xs text-subtle">
		<span>{data[0].label}</span>
		<span>{data[data.length - 1].label}</span>
	</div>
{/if}
