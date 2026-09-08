<script lang="ts">
	import { compact } from '$lib/format';

	interface Point {
		label: string;
		value: number;
	}

	let { data }: { data: Point[] } = $props();

	const W = 600;
	const H = 200;
	const PAD = 6;

	const max = $derived(Math.max(1, ...data.map((d) => d.value)));
	const pts = $derived(
		data.map((d, i) => ({
			x: data.length === 1 ? W / 2 : PAD + (i / (data.length - 1)) * (W - PAD * 2),
			y: H - PAD - (d.value / max) * (H - PAD * 2 - 20)
		}))
	);
	const line = $derived(
		pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
	);
	const area = $derived(
		pts.length
			? `${line} L${pts[pts.length - 1].x.toFixed(1)},${H} L${pts[0].x.toFixed(1)},${H} Z`
			: ''
	);
</script>

{#if !data.length}
	<p class="py-8 text-center text-sm text-subtle">No data in range</p>
{:else}
	<svg
		viewBox="0 0 {W} {H}"
		preserveAspectRatio="none"
		class="h-44 w-full"
		role="img"
		aria-label="Area chart"
	>
		<line
			x1="0"
			y1={H - PAD}
			x2={W}
			y2={H - PAD}
			stroke="var(--color-line)"
			stroke-width="1"
			vector-effect="non-scaling-stroke"
		/>
		<path d={area} fill="var(--color-accent)" opacity="0.15" />
		<path
			d={line}
			fill="none"
			stroke="var(--color-accent)"
			stroke-width="2"
			vector-effect="non-scaling-stroke"
			stroke-linejoin="round"
		/>
		<text x={PAD} y={PAD + 8} font-size="11" fill="var(--color-subtle)">
			max {compact(max)}
		</text>
	</svg>
	<div class="mt-1 flex justify-between text-xs text-subtle">
		<span>{data[0].label}</span>
		<span>{data[data.length - 1].label}</span>
	</div>
{/if}
